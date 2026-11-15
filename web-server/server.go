package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

//go:embed index.html
var indexHTML []byte

type hub struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
}

func newHub() *hub { return &hub{clients: map[chan []byte]struct{}{}} }

func (h *hub) sub() chan []byte {
	ch := make(chan []byte, 512)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *hub) unsub(ch chan []byte) {
	h.mu.Lock()
	delete(h.clients, ch)
	h.mu.Unlock()
}

// pub never blocks: a client that cannot keep up is dropped and reconnects,
// and the page reloads its state when it does.
func (h *hub) pub(b []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- b:
		default:
			delete(h.clients, ch)
			close(ch)
		}
	}
}

type app struct {
	mu         sync.Mutex
	status     string // idle | connecting | ready | error
	errMsg     string
	dc         *discord
	cancel     context.CancelFunc
	st         *store
	hub        *hub
	secret     string
	hosts      []string
	onQuit     func()
	lastSeen   time.Time
	serverMode bool
	gen        int // bumps on every login/logout so stale gateway callbacks are ignored
}

func newApp(secret string) *app {
	return &app{status: "idle", st: newStore(), hub: newHub(), secret: secret, onQuit: func() {}, lastSeen: time.Now()}
}

func (a *app) idleFor() time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	return time.Since(a.lastSeen)
}

func (a *app) touch() {
	a.mu.Lock()
	a.lastSeen = time.Now()
	a.mu.Unlock()
}

func (a *app) handler() http.Handler {
	p := "/" + a.secret + "/"
	mux := http.NewServeMux()
	mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != p || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	})
	mux.HandleFunc(p+"api/state", a.getState)
	mux.HandleFunc(p+"api/events", a.events)
	mux.HandleFunc(p+"api/messages", a.messages)
	mux.HandleFunc(p+"api/login", a.post(a.login))
	mux.HandleFunc(p+"api/logout", a.post(a.logout))
	mux.HandleFunc(p+"api/send", a.post(a.send))
	mux.HandleFunc(p+"api/delete", a.post(a.deleteMsg))
	mux.HandleFunc(p+"api/quit", a.post(a.quit))
	mux.HandleFunc(p+"api/edit", a.post(a.editMsg))
	mux.HandleFunc(p+"api/react", a.post(a.react))
	mux.HandleFunc(p+"api/typing", a.post(a.typing))
	mux.HandleFunc(p+"api/dm", a.post(a.openDM))
	mux.HandleFunc(p+"api/members", a.members)
	mux.HandleFunc(p+"api/upload", a.postLimit(a.upload, maxUpload+(1<<20)))
	return a.guard(mux)
}

// guard answers only requests addressed to our own loopback host (this blocks
// DNS-rebinding) and adds restrictive headers.
func (a *app) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok := a.serverMode // server mode: password gate instead of loopback host check
		for _, h := range a.hosts {
			if r.Host == h {
				ok = true
			}
		}
		if !ok {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com https://media.discordapp.net https://images-ext-1.discordapp.net; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		next.ServeHTTP(w, r)
	})
}

// post requires POST plus a custom header, which other websites cannot send.
func (a *app) post(h http.HandlerFunc) http.HandlerFunc { return a.postLimit(h, 64<<10) }

func (a *app) postLimit(h http.HandlerFunc, limit int64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("X-BD") != "1" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (a *app) emit(t string, d any) {
	b, err := json.Marshal(map[string]any{"t": t, "d": d})
	if err == nil {
		a.hub.pub(b)
	}
}

func (a *app) setStatus(gen int, status, msg string) {
	a.mu.Lock()
	if gen != a.gen {
		a.mu.Unlock()
		return
	}
	a.status, a.errMsg = status, msg
	a.mu.Unlock()
	a.emit("status", map[string]string{"status": status, "error": msg})
}

func (a *app) getState(w http.ResponseWriter, r *http.Request) {
	a.touch()
	a.mu.Lock()
	status, msg := a.status, a.errMsg
	a.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "error": msg, "snapshot": a.st.snapshot()})
}

func (a *app) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	ch := a.hub.sub()
	defer a.hub.unsub(ch)
	w.Write([]byte(": hi\n\n"))
	fl.Flush()
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case b, ok := <-ch:
			if !ok {
				return
			}
			w.Write([]byte("data: "))
			w.Write(b)
			w.Write([]byte("\n\n"))
			fl.Flush()
		case <-tick.C:
			a.touch()
			w.Write([]byte(": ping\n\n"))
			fl.Flush()
		}
	}
}

func (a *app) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token          string `json:"token"`
		MessageContent bool   `json:"messageContent"`
		Members        bool   `json:"members"`
	}
	if json.NewDecoder(r.Body).Decode(&in) != nil {
		errJSON(w, http.StatusBadRequest, "bad request")
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(in.Token), "Bot "))
	if len(token) < 20 || len(token) > 200 || strings.ContainsAny(token, " \t\r\n\"") {
		errJSON(w, http.StatusBadRequest, "รูปแบบโทเคนไม่ถูกต้อง")
		return
	}
	dc := newDiscord(token)
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	code, body, err := dc.do(ctx, "GET", "/users/@me", nil)
	if err != nil {
		errJSON(w, http.StatusBadGateway, "เชื่อมต่อ Discord ไม่ได้: "+sanitizeErr(err, token))
		return
	}
	if code != http.StatusOK {
		errJSON(w, http.StatusUnauthorized, apiError(code, body))
		return
	}
	var me user
	if json.Unmarshal(body, &me) != nil || me.ID == "" {
		errJSON(w, http.StatusBadGateway, "ข้อมูลจาก Discord ผิดรูปแบบ")
		return
	}

	a.stop()
	a.mu.Lock()
	a.gen++
	gen := a.gen
	a.dc = dc
	a.status, a.errMsg = "connecting", ""
	gctx, gcancel := context.WithCancel(context.Background())
	a.cancel = gcancel
	a.mu.Unlock()
	a.st.reset(me)

	intents := intentGuilds | intentGuildMessages | intentGuildReactions | intentDMs
	if in.MessageContent {
		intents |= intentMessageContent
	}
	if in.Members {
		intents |= intentMembers
	}
	g := &gateway{
		token:   token,
		intents: intents,
		onEvent: func(t string, d json.RawMessage) {
			a.mu.Lock()
			stale := gen != a.gen
			a.mu.Unlock()
			if stale {
				return
			}
			if a.st.apply(t, d) {
				a.emit("state", nil)
			}
			switch t {
			case "MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE":
				a.emit(t, json.RawMessage(d))
			}
		},
		onStatus: func(status, msg string) { a.setStatus(gen, status, msg) },
	}
	go g.run(gctx)
	a.emit("status", map[string]string{"status": "connecting", "error": ""})
	writeJSON(w, http.StatusOK, map[string]string{"ok": "connecting"})
}

func sanitizeErr(err error, token string) string {
	return strings.ReplaceAll(err.Error(), token, "***")
}

// stop ends any running gateway session and forgets the token.
func (a *app) stop() {
	a.mu.Lock()
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	a.dc = nil
	a.mu.Unlock()
}

func (a *app) logout(w http.ResponseWriter, r *http.Request) {
	a.stop()
	a.mu.Lock()
	a.gen++
	a.status, a.errMsg = "idle", ""
	a.mu.Unlock()
	a.st.reset(user{})
	a.emit("status", map[string]string{"status": "idle", "error": ""})
	writeJSON(w, http.StatusOK, map[string]string{"ok": "bye"})
}

func (a *app) client(w http.ResponseWriter) *discord {
	a.mu.Lock()
	dc := a.dc
	a.mu.Unlock()
	if dc == nil {
		errJSON(w, http.StatusUnauthorized, "ยังไม่ได้ล็อกอิน")
	}
	return dc
}

func (a *app) messages(w http.ResponseWriter, r *http.Request) {
	dc := a.client(w)
	if dc == nil {
		return
	}
	q := r.URL.Query()
	ch, before := q.Get("channel"), q.Get("before")
	if !snowflake.MatchString(ch) || (before != "" && !snowflake.MatchString(before)) {
		errJSON(w, http.StatusBadRequest, "bad id")
		return
	}
	path := "/channels/" + ch + "/messages?limit=50"
	if before != "" {
		path += "&before=" + url.QueryEscape(before)
	}
	code, body, err := dc.do(r.Context(), "GET", path, nil)
	if err != nil {
		errJSON(w, http.StatusBadGateway, sanitizeErr(err, dc.token))
		return
	}
	if code != http.StatusOK {
		errJSON(w, code, apiError(code, body))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

func (a *app) send(w http.ResponseWriter, r *http.Request) {
	dc := a.client(w)
	if dc == nil {
		return
	}
	var in struct {
		Channel string `json:"channel"`
		Content string `json:"content"`
		ReplyTo string `json:"replyTo"`
	}
	if json.NewDecoder(r.Body).Decode(&in) != nil || !snowflake.MatchString(in.Channel) ||
		(in.ReplyTo != "" && !snowflake.MatchString(in.ReplyTo)) {
		errJSON(w, http.StatusBadRequest, "bad request")
		return
	}
	n := len([]rune(in.Content))
	if strings.TrimSpace(in.Content) == "" || n > 2000 {
		errJSON(w, http.StatusBadRequest, "ข้อความต้องมี 1–2000 ตัวอักษร")
		return
	}
	body := map[string]any{
		"content":          in.Content,
		"allowed_mentions": map[string]any{"parse": []string{"users", "roles"}, "replied_user": true},
	}
	if in.ReplyTo != "" {
		body["message_reference"] = map[string]any{"message_id": in.ReplyTo, "fail_if_not_exists": false}
	}
	code, resp, err := dc.do(r.Context(), "POST", "/channels/"+in.Channel+"/messages", body)
	if err != nil {
		errJSON(w, http.StatusBadGateway, sanitizeErr(err, dc.token))
		return
	}
	if code != http.StatusOK {
		errJSON(w, code, apiError(code, resp))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "sent"})
}

func (a *app) deleteMsg(w http.ResponseWriter, r *http.Request) {
	dc := a.client(w)
	if dc == nil {
		return
	}
	var in struct {
		Channel string `json:"channel"`
		ID      string `json:"id"`
	}
	if json.NewDecoder(r.Body).Decode(&in) != nil || !snowflake.MatchString(in.Channel) || !snowflake.MatchString(in.ID) {
		errJSON(w, http.StatusBadRequest, "bad request")
		return
	}
	code, resp, err := dc.do(r.Context(), "DELETE", "/channels/"+in.Channel+"/messages/"+in.ID, nil)
	if err != nil {
		errJSON(w, http.StatusBadGateway, sanitizeErr(err, dc.token))
		return
	}
	if code != http.StatusNoContent && code != http.StatusOK {
		errJSON(w, code, apiError(code, resp))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "deleted"})
}

func (a *app) quit(w http.ResponseWriter, r *http.Request) {
	a.stop()
	writeJSON(w, http.StatusOK, map[string]string{"ok": "bye"})
	go func() {
		time.Sleep(200 * time.Millisecond)
		a.onQuit()
	}()
}
