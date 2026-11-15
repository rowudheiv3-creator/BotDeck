package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	maxUpload = 25 << 20 // total bytes of attachments per message
	maxFiles  = 10
)

// customEmoji is "name:id"; anything else is treated as a unicode emoji.
var customEmoji = regexp.MustCompile(`^[A-Za-z0-9_]{2,32}:[0-9]{1,20}$`)

func validEmoji(e string) bool {
	if customEmoji.MatchString(e) {
		return true
	}
	n := utf8.RuneCountInString(e)
	return n >= 1 && n <= 16 && !strings.ContainsAny(e, "/?#%\\:\"") && utf8.ValidString(e)
}

// relay writes a Discord answer back to the page: bodies pass through, errors get a short message.
func relay(w http.ResponseWriter, code int, body []byte, err error, token string) {
	if err != nil {
		errJSON(w, http.StatusBadGateway, sanitizeErr(err, token))
		return
	}
	if code < 200 || code > 299 {
		errJSON(w, code, apiError(code, body))
		return
	}
	if len(bytes.TrimSpace(body)) == 0 {
		writeJSON(w, http.StatusOK, map[string]string{"ok": "done"})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

func (a *app) editMsg(w http.ResponseWriter, r *http.Request) {
	dc := a.client(w)
	if dc == nil {
		return
	}
	var in struct {
		Channel string `json:"channel"`
		ID      string `json:"id"`
		Content string `json:"content"`
	}
	if json.NewDecoder(r.Body).Decode(&in) != nil || !snowflake.MatchString(in.Channel) || !snowflake.MatchString(in.ID) ||
		strings.TrimSpace(in.Content) == "" || utf8.RuneCountInString(in.Content) > 2000 {
		errJSON(w, http.StatusBadRequest, "bad request")
		return
	}
	code, body, err := dc.do(r.Context(), "PATCH", "/channels/"+in.Channel+"/messages/"+in.ID, map[string]any{"content": in.Content})
	relay(w, code, body, err, dc.token)
}

func (a *app) react(w http.ResponseWriter, r *http.Request) {
	dc := a.client(w)
	if dc == nil {
		return
	}
	var in struct {
		Channel string `json:"channel"`
		ID      string `json:"id"`
		Emoji   string `json:"emoji"`
		On      bool   `json:"on"`
	}
	if json.NewDecoder(r.Body).Decode(&in) != nil || !snowflake.MatchString(in.Channel) || !snowflake.MatchString(in.ID) || !validEmoji(in.Emoji) {
		errJSON(w, http.StatusBadRequest, "bad request")
		return
	}
	method := "DELETE"
	if in.On {
		method = "PUT"
	}
	path := "/channels/" + in.Channel + "/messages/" + in.ID + "/reactions/" + url.PathEscape(in.Emoji) + "/@me"
	code, body, err := dc.do(r.Context(), method, path, nil)
	relay(w, code, body, err, dc.token)
}

func (a *app) typing(w http.ResponseWriter, r *http.Request) {
	dc := a.client(w)
	if dc == nil {
		return
	}
	var in struct {
		Channel string `json:"channel"`
	}
	if json.NewDecoder(r.Body).Decode(&in) != nil || !snowflake.MatchString(in.Channel) {
		errJSON(w, http.StatusBadRequest, "bad request")
		return
	}
	code, body, err := dc.do(r.Context(), "POST", "/channels/"+in.Channel+"/typing", nil)
	relay(w, code, body, err, dc.token)
}

func (a *app) openDM(w http.ResponseWriter, r *http.Request) {
	dc := a.client(w)
	if dc == nil {
		return
	}
	var in struct {
		User string `json:"user"`
	}
	if json.NewDecoder(r.Body).Decode(&in) != nil || !snowflake.MatchString(in.User) {
		errJSON(w, http.StatusBadRequest, "bad request")
		return
	}
	code, body, err := dc.do(r.Context(), "POST", "/users/@me/channels", map[string]string{"recipient_id": in.User})
	relay(w, code, body, err, dc.token)
}

func (a *app) members(w http.ResponseWriter, r *http.Request) {
	dc := a.client(w)
	if dc == nil {
		return
	}
	g := r.URL.Query().Get("guild")
	if !snowflake.MatchString(g) {
		errJSON(w, http.StatusBadRequest, "bad id")
		return
	}
	code, body, err := dc.do(r.Context(), "GET", "/guilds/"+g+"/members?limit=1000", nil)
	if code == http.StatusForbidden {
		errJSON(w, code, "ต้องเปิด Server Members Intent ใน Developer Portal แล้วติ๊ก \"แสดงรายชื่อสมาชิก\" ตอนล็อกอิน")
		return
	}
	relay(w, code, body, err, dc.token)
}

// upload forwards a multipart form (channel, content, replyTo, files) to Discord as one message.
func (a *app) upload(w http.ResponseWriter, r *http.Request) {
	dc := a.client(w)
	if dc == nil {
		return
	}
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		errJSON(w, http.StatusRequestEntityTooLarge, "ไฟล์ใหญ่เกินไป (รวมไม่เกิน 25 MB) / too large")
		return
	}
	ch, content, replyTo := r.FormValue("channel"), r.FormValue("content"), r.FormValue("replyTo")
	files := r.MultipartForm.File["files"]
	if !snowflake.MatchString(ch) || (replyTo != "" && !snowflake.MatchString(replyTo)) ||
		len(files) == 0 || len(files) > maxFiles || utf8.RuneCountInString(content) > 2000 {
		errJSON(w, http.StatusBadRequest, "bad request")
		return
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	payload := map[string]any{
		"content":          content,
		"allowed_mentions": map[string]any{"parse": []string{"users", "roles"}, "replied_user": true},
	}
	if replyTo != "" {
		payload["message_reference"] = map[string]any{"message_id": replyTo, "fail_if_not_exists": false}
	}
	atts := make([]map[string]any, 0, len(files))
	for i, fh := range files {
		atts = append(atts, map[string]any{"id": i, "filename": safeName(fh.Filename)})
	}
	payload["attachments"] = atts
	pj, _ := json.Marshal(payload)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="payload_json"`)
	h.Set("Content-Type", "application/json")
	pw, _ := mw.CreatePart(h)
	pw.Write(pj)
	var total int64
	for i, fh := range files {
		total += fh.Size
		if total > maxUpload {
			errJSON(w, http.StatusRequestEntityTooLarge, "ไฟล์ใหญ่เกินไป (รวมไม่เกิน 25 MB) / too large")
			return
		}
		src, err := fh.Open()
		if err != nil {
			errJSON(w, http.StatusBadRequest, "อ่านไฟล์ไม่ได้")
			return
		}
		fh2 := textproto.MIMEHeader{}
		fh2.Set("Content-Disposition", fmt.Sprintf(`form-data; name="files[%d]"; filename="%s"`, i, safeName(fh.Filename)))
		fh2.Set("Content-Type", "application/octet-stream")
		part, _ := mw.CreatePart(fh2)
		_, err = io.Copy(part, src)
		src.Close()
		if err != nil {
			errJSON(w, http.StatusBadRequest, "อ่านไฟล์ไม่ได้")
			return
		}
	}
	mw.Close()
	code, body, err := dc.doBytes(r.Context(), "POST", "/channels/"+ch+"/messages", mw.FormDataContentType(), buf.Bytes())
	relay(w, code, body, err, dc.token)
}

// safeName keeps only a plain file name with no path or quote characters.
func safeName(n string) string {
	n = filepath.Base(strings.ReplaceAll(n, `\`, "/"))
	n = strings.Map(func(r rune) rune {
		if r < 32 || r == '"' || r == '/' || r == '\\' {
			return '_'
		}
		return r
	}, n)
	if n == "" || n == "." || n == ".." {
		return "file"
	}
	return n
}
