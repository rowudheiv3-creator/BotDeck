package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- a fake Discord: REST + gateway ----------

type fakeDiscord struct {
	t   *testing.T
	srv *httptest.Server

	mu        sync.Mutex
	gotAuth   []string
	sent      []map[string]any
	deleted   []string
	calls     []string
	uploads   []map[string]any
	identify  []map[string]any
	resumes   []map[string]any
	beats     int
	conns     int
	pushNext  chan string // raw JSON frames the test wants pushed to the live connection
	dropAfter chan struct{}
}

func serverFrame(c net.Conn, op byte, payload []byte) error {
	buf := []byte{0x80 | op}
	n := len(payload)
	switch {
	case n < 126:
		buf = append(buf, byte(n))
	case n <= 0xffff:
		buf = append(buf, 126, byte(n>>8), byte(n))
	default:
		buf = append(buf, 127)
		buf = binary.BigEndian.AppendUint64(buf, uint64(n))
	}
	_, err := c.Write(append(buf, payload...))
	return err
}

func serverRead(br *bufio.Reader) (byte, []byte, error) {
	var h [2]byte
	if _, err := io.ReadFull(br, h[:]); err != nil {
		return 0, nil, err
	}
	n := int(h[1] & 0x7f)
	if n == 126 {
		var b [2]byte
		io.ReadFull(br, b[:])
		n = int(binary.BigEndian.Uint16(b[:]))
	} else if n == 127 {
		var b [8]byte
		io.ReadFull(br, b[:])
		n = int(binary.BigEndian.Uint64(b[:]))
	}
	var mk [4]byte
	if h[1]&0x80 != 0 {
		io.ReadFull(br, mk[:])
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(br, p); err != nil {
		return 0, nil, err
	}
	if h[1]&0x80 != 0 {
		for i := range p {
			p[i] ^= mk[i%4]
		}
	}
	return h[0] & 0x0f, p, nil
}

func newFakeDiscord(t *testing.T) *fakeDiscord {
	f := &fakeDiscord{t: t, pushNext: make(chan string, 16), dropAfter: make(chan struct{}, 4)}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v10/users/@me", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.gotAuth = append(f.gotAuth, r.Header.Get("Authorization"))
		f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bot good-token-0123456789abcdef" {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"message":"401: Unauthorized","code":0}`)
			return
		}
		fmt.Fprint(w, `{"id":"111","username":"testbot","avatar":null}`)
	})
	mux.HandleFunc("/api/v10/channels/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/messages"):
			if strings.Contains(r.URL.Path, "/403/") {
				w.WriteHeader(403)
				fmt.Fprint(w, `{"message":"Missing Access"}`)
				return
			}
			fmt.Fprint(w, `[{"id":"902","content":"newer","timestamp":"2026-01-01T00:00:02Z","author":{"id":"5","username":"a"}},{"id":"901","content":"older","timestamp":"2026-01-01T00:00:01Z","author":{"id":"5","username":"a"}}]`)
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/messages") && strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/"):
			if err := r.ParseMultipartForm(32 << 20); err != nil {
				w.WriteHeader(400)
				return
			}
			var pj map[string]any
			json.Unmarshal([]byte(r.FormValue("payload_json")), &pj)
			var names []string
			for k, fhs := range r.MultipartForm.File {
				for _, fh := range fhs {
					src, _ := fh.Open()
					data, _ := io.ReadAll(src)
					names = append(names, k+"="+fh.Filename+":"+string(data))
				}
			}
			f.uploads = append(f.uploads, map[string]any{"payload": pj, "files": names, "_path": r.URL.Path})
			fmt.Fprint(w, `{"id":"1001"}`)
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/messages"):
			var b map[string]any
			json.NewDecoder(r.Body).Decode(&b)
			b["_path"] = r.URL.Path
			f.sent = append(f.sent, b)
			fmt.Fprint(w, `{"id":"1000"}`)
		case r.Method == "PATCH":
			var b map[string]any
			json.NewDecoder(r.Body).Decode(&b)
			f.calls = append(f.calls, "PATCH "+r.URL.Path+" "+fmt.Sprint(b["content"]))
			fmt.Fprint(w, `{"id":"901","content":"edited"}`)
		case (r.Method == "PUT" || r.Method == "DELETE") && strings.Contains(r.URL.Path, "/reactions/"):
			f.calls = append(f.calls, r.Method+" "+r.URL.EscapedPath())
			w.WriteHeader(204)
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/typing"):
			f.calls = append(f.calls, "TYPING "+r.URL.Path)
			w.WriteHeader(204)
		case r.Method == "DELETE":
			f.deleted = append(f.deleted, r.URL.Path)
			w.WriteHeader(204)
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/api/v10/users/@me/channels", func(w http.ResponseWriter, r *http.Request) {
		var b map[string]string
		json.NewDecoder(r.Body).Decode(&b)
		fmt.Fprintf(w, `{"id":"dm-%s","type":1}`, b["recipient_id"])
	})
	mux.HandleFunc("/api/v10/guilds/", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/403/") {
			w.WriteHeader(403)
			fmt.Fprint(w, `{"message":"Missing Access"}`)
			return
		}
		fmt.Fprint(w, `[{"user":{"id":"5","username":"alice"},"roles":["r1"]}]`)
	})
	mux.HandleFunc("/gw", f.gateway)
	mux.HandleFunc("/{$}", f.gateway) // resume URL is a bare host; the client appends /?v=10&encoding=json
	f.srv = httptest.NewServer(mux)
	return f
}

func (f *fakeDiscord) gateway(w http.ResponseWriter, r *http.Request) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		return
	}
	c, brw, err := hj.Hijack()
	if err != nil {
		return
	}
	defer c.Close()
	fmt.Fprintf(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
		wsAccept(r.Header.Get("Sec-WebSocket-Key")))
	br := brw.Reader
	f.mu.Lock()
	f.conns++
	n := f.conns
	f.mu.Unlock()

	serverFrame(c, 1, []byte(`{"op":10,"d":{"heartbeat_interval":60}}`))
	var wmu sync.Mutex
	send := func(s string) { wmu.Lock(); serverFrame(c, 1, []byte(s)); wmu.Unlock() }

	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case <-done:
				return
			case s := <-f.pushNext:
				send(s)
			case <-f.dropAfter:
				send(`{"op":7,"d":null}`)
			}
		}
	}()

	for {
		op, p, err := serverRead(br)
		if err != nil || op == 8 {
			return
		}
		var m struct {
			Op int            `json:"op"`
			D  map[string]any `json:"d"`
		}
		json.Unmarshal(p, &m)
		switch m.Op {
		case 1:
			f.mu.Lock()
			f.beats++
			f.mu.Unlock()
			send(`{"op":11}`)
		case 2:
			f.mu.Lock()
			f.identify = append(f.identify, m.D)
			f.mu.Unlock()
			send(`{"op":0,"s":1,"t":"READY","d":{"user":{"id":"111","username":"testbot"},"session_id":"sess1","resume_gateway_url":"` +
				strings.Replace(f.srv.URL, "http", "ws", 1) + `","guilds":[{"id":"10","unavailable":true}]}}`)
			send(`{"op":0,"s":2,"t":"GUILD_CREATE","d":{"id":"10","name":"Test Guild","icon":null,"emojis":[{"id":"501","name":"party","animated":true},{"id":"502","name":"gone","available":false}],"roles":[{"id":"r1","name":"Mod","color":16711680,"position":2}],"channels":[` +
				`{"id":"21","name":"general","type":0,"position":1,"parent_id":"20"},` +
				`{"id":"20","name":"Text","type":4,"position":0},` +
				`{"id":"22","name":"Voice","type":2,"position":2,"parent_id":"20"}]}}`)
		case 6:
			f.mu.Lock()
			f.resumes = append(f.resumes, m.D)
			f.mu.Unlock()
			send(`{"op":0,"s":5,"t":"RESUMED","d":{}}`)
		}
		_ = n
	}
}

// ---------- test rig around the real app ----------

type rig struct {
	t    *testing.T
	f    *fakeDiscord
	a    *app
	ts   *httptest.Server
	base string
}

func newRig(t *testing.T) *rig {
	f := newFakeDiscord(t)
	oldAPI, oldGW, oldBackoff := apiBase, gatewayURL, reconnectBase
	apiBase = f.srv.URL + "/api/v10"
	gatewayURL = strings.Replace(f.srv.URL, "http", "ws", 1) + "/gw"
	reconnectBase = 20 * time.Millisecond
	a := newApp("sekret")
	ts := httptest.NewUnstartedServer(nil)
	a.hosts = []string{ts.Listener.Addr().String()}
	ts.Config.Handler = a.handler()
	ts.Start()
	t.Cleanup(func() {
		a.stop()
		ts.Close()
		f.srv.Close()
		apiBase, gatewayURL, reconnectBase = oldAPI, oldGW, oldBackoff
	})
	return &rig{t: t, f: f, a: a, ts: ts, base: ts.URL + "/sekret/"}
}

func (g *rig) post(path, body string) (int, map[string]any) {
	req, _ := http.NewRequest("POST", g.base+"api/"+path, strings.NewReader(body))
	req.Header.Set("X-BD", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		g.t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

func (g *rig) state() (string, string, snapshot) {
	resp, err := http.Get(g.base + "api/state")
	if err != nil {
		g.t.Fatal(err)
	}
	defer resp.Body.Close()
	var s struct {
		Status   string   `json:"status"`
		Error    string   `json:"error"`
		Snapshot snapshot `json:"snapshot"`
	}
	json.NewDecoder(resp.Body).Decode(&s)
	return s.Status, s.Error, s.Snapshot
}

func (g *rig) waitFor(what string, cond func() bool) {
	g.t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	g.t.Fatalf("timed out waiting for %s", what)
}

// sse reads events from /api/events into a channel.
func (g *rig) sse() (<-chan map[string]any, func()) {
	resp, err := http.Get(g.base + "api/events")
	if err != nil {
		g.t.Fatal(err)
	}
	out := make(chan map[string]any, 64)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 8<<20)
		for sc.Scan() {
			if line, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				var m map[string]any
				if json.Unmarshal([]byte(line), &m) == nil {
					out <- m
				}
			}
		}
	}()
	return out, func() { resp.Body.Close() }
}

const goodTok = `{"token":"good-token-0123456789abcdef","messageContent":true}`

// ---------- tests ----------

func TestLoginIdentifyAndState(t *testing.T) {
	g := newRig(t)
	if code, _ := g.post("login", goodTok); code != 200 {
		t.Fatalf("login: %d", code)
	}
	g.waitFor("ready", func() bool { s, _, sn := g.state(); return s == "ready" && len(sn.Guilds) == 1 })
	_, _, sn := g.state()
	if sn.Me.Username != "testbot" || sn.Guilds[0].Name != "Test Guild" || len(sn.Guilds[0].Channels) != 3 {
		t.Fatalf("snapshot wrong: %+v", sn)
	}
	if sn.Guilds[0].Channels[0].Name != "Text" { // sorted by position
		t.Fatalf("channels not sorted: %+v", sn.Guilds[0].Channels)
	}
	g.f.mu.Lock()
	defer g.f.mu.Unlock()
	id := g.f.identify[0]
	if id["token"] != "good-token-0123456789abcdef" {
		t.Errorf("identify token: %v", id["token"])
	}
	want := float64(intentGuilds | intentGuildMessages | intentGuildReactions | intentDMs | intentMessageContent)
	if id["intents"] != want {
		t.Errorf("intents %v, want %v", id["intents"], want)
	}
	for _, a := range g.f.gotAuth {
		if a != "Bot good-token-0123456789abcdef" {
			t.Errorf("auth header %q", a)
		}
	}
}

func TestMessageContentIntentIsOptional(t *testing.T) {
	g := newRig(t)
	g.post("login", `{"token":"good-token-0123456789abcdef","messageContent":false}`)
	g.waitFor("identify", func() bool { g.f.mu.Lock(); defer g.f.mu.Unlock(); return len(g.f.identify) == 1 })
	g.f.mu.Lock()
	defer g.f.mu.Unlock()
	if int(g.f.identify[0]["intents"].(float64))&intentMessageContent != 0 {
		t.Fatal("privileged intent requested although unticked")
	}
}

func TestBadTokenIsRejectedBeforeGateway(t *testing.T) {
	g := newRig(t)
	code, m := g.post("login", `{"token":"bad-token-0123456789abcdefgh"}`)
	if code != 401 || !strings.Contains(fmt.Sprint(m["error"]), "โทเคน") {
		t.Fatalf("got %d %v", code, m)
	}
	if code, _ := g.post("login", `{"token":"short"}`); code != 400 {
		t.Fatalf("malformed token: %d", code)
	}
	g.f.mu.Lock()
	defer g.f.mu.Unlock()
	if g.f.conns != 0 {
		t.Fatal("gateway must not be contacted with a bad token")
	}
}

func TestLiveMessagesReachBrowser(t *testing.T) {
	g := newRig(t)
	events, stop := g.sse()
	defer stop()
	g.post("login", goodTok)
	g.waitFor("ready", func() bool { s, _, sn := g.state(); return s == "ready" && len(sn.Guilds) == 1 })
	g.f.pushNext <- `{"op":0,"s":3,"t":"MESSAGE_CREATE","d":{"id":"777","channel_id":"21","content":"hello **live**","author":{"id":"5","username":"a"}}}`
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-events:
			if ev["t"] == "MESSAGE_CREATE" {
				d := ev["d"].(map[string]any)
				if d["content"] != "hello **live**" || d["channel_id"] != "21" {
					t.Fatalf("event body wrong: %v", d)
				}
				return
			}
		case <-deadline:
			t.Fatal("no live MESSAGE_CREATE arrived")
		}
	}
}

func TestChannelCreateUpdatesState(t *testing.T) {
	g := newRig(t)
	g.post("login", goodTok)
	g.waitFor("ready", func() bool { _, _, sn := g.state(); return len(sn.Guilds) == 1 })
	g.f.pushNext <- `{"op":0,"s":3,"t":"CHANNEL_CREATE","d":{"id":"23","guild_id":"10","name":"new","type":0,"position":9}}`
	g.waitFor("channel", func() bool { _, _, sn := g.state(); return len(sn.Guilds[0].Channels) == 4 })
	g.f.pushNext <- `{"op":0,"s":4,"t":"CHANNEL_DELETE","d":{"id":"23","guild_id":"10","type":0}}`
	g.waitFor("channel removed", func() bool { _, _, sn := g.state(); return len(sn.Guilds[0].Channels) == 3 })
}

func TestSendDeleteAndHistory(t *testing.T) {
	g := newRig(t)
	g.post("login", goodTok)
	g.waitFor("ready", func() bool { s, _, _ := g.state(); return s == "ready" })

	if code, _ := g.post("send", `{"channel":"21","content":"hi there","replyTo":"901"}`); code != 200 {
		t.Fatalf("send: %d", code)
	}
	g.f.mu.Lock()
	sent := g.f.sent[0]
	g.f.mu.Unlock()
	ref := sent["message_reference"].(map[string]any)
	if sent["content"] != "hi there" || ref["message_id"] != "901" || sent["_path"] != "/api/v10/channels/21/messages" {
		t.Fatalf("sent wrong: %v", sent)
	}
	if am := sent["allowed_mentions"].(map[string]any)["parse"].([]any); len(am) != 2 {
		t.Fatalf("@everyone must not be allowed: %v", am)
	}
	for _, bad := range []string{`{"channel":"21","content":""}`, `{"channel":"21","content":"` + strings.Repeat("x", 2001) + `"}`, `{"channel":"../x","content":"a"}`, `{"channel":"21","content":"a","replyTo":"x/y"}`} {
		if code, _ := g.post("send", bad); code != 400 {
			t.Errorf("send %.40s... should be 400, got %d", bad, code)
		}
	}
	if code, _ := g.post("delete", `{"channel":"21","id":"901"}`); code != 200 {
		t.Fatalf("delete: %d", code)
	}
	g.f.mu.Lock()
	if len(g.f.deleted) != 1 || g.f.deleted[0] != "/api/v10/channels/21/messages/901" {
		t.Fatalf("deleted: %v", g.f.deleted)
	}
	g.f.mu.Unlock()

	resp, _ := http.Get(g.base + "api/messages?channel=21")
	var msgs []map[string]any
	json.NewDecoder(resp.Body).Decode(&msgs)
	if resp.StatusCode != 200 || len(msgs) != 2 {
		t.Fatalf("history: %d %v", resp.StatusCode, msgs)
	}
	if resp, _ := http.Get(g.base + "api/messages?channel=403"); resp.StatusCode != 403 {
		t.Fatalf("forbidden channel must surface 403, got %d", resp.StatusCode)
	}
	if resp, _ := http.Get(g.base + "api/messages?channel=21/../x"); resp.StatusCode != 400 {
		t.Fatalf("bad id must be 400, got %d", resp.StatusCode)
	}
}

func TestReconnectResumesSession(t *testing.T) {
	g := newRig(t)
	g.post("login", goodTok)
	g.waitFor("ready", func() bool { s, _, sn := g.state(); return s == "ready" && len(sn.Guilds) == 1 })
	g.f.dropAfter <- struct{}{} // server sends op 7 "reconnect"
	g.waitFor("resume", func() bool { g.f.mu.Lock(); defer g.f.mu.Unlock(); return len(g.f.resumes) == 1 })
	g.f.mu.Lock()
	r := g.f.resumes[0]
	idents := len(g.f.identify)
	g.f.mu.Unlock()
	if r["session_id"] != "sess1" || r["token"] != "good-token-0123456789abcdef" || r["seq"].(float64) < 2 {
		t.Fatalf("resume payload: %v", r)
	}
	if idents != 1 {
		t.Fatalf("must resume, not re-identify (%d identifies)", idents)
	}
	g.waitFor("ready again", func() bool { s, _, _ := g.state(); return s == "ready" })
}

func TestHeartbeatsAreSent(t *testing.T) {
	g := newRig(t)
	g.post("login", goodTok)
	g.waitFor("heartbeats", func() bool { g.f.mu.Lock(); defer g.f.mu.Unlock(); return g.f.beats >= 2 })
}

func TestLogoutStopsAndForgets(t *testing.T) {
	g := newRig(t)
	g.post("login", goodTok)
	g.waitFor("ready", func() bool { s, _, _ := g.state(); return s == "ready" })
	g.post("logout", `{}`)
	if s, _, sn := g.state(); s != "idle" || len(sn.Guilds) != 0 || sn.Me.ID != "" {
		t.Fatalf("state after logout: %v %+v", s, sn)
	}
	if code, _ := g.post("send", `{"channel":"21","content":"x"}`); code != 401 {
		t.Fatalf("send after logout must be 401, got %d", code)
	}
}

func TestFatalCloseCodeSurfacesMessage(t *testing.T) {
	// A gateway that closes with 4014 (disallowed intents) must produce a clear error, not a retry loop.
	a := newApp("s")
	var mu sync.Mutex
	var gotStatus, gotMsg string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, brw, _ := w.(http.Hijacker).Hijack()
		defer c.Close()
		fmt.Fprintf(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", wsAccept(r.Header.Get("Sec-WebSocket-Key")))
		serverFrame(c, 1, []byte(`{"op":10,"d":{"heartbeat_interval":60000}}`))
		serverRead(brw.Reader) // identify
		serverFrame(c, 8, binary.BigEndian.AppendUint16(nil, 4014))
	}))
	defer srv.Close()
	old := gatewayURL
	gatewayURL = strings.Replace(srv.URL, "http", "ws", 1)
	defer func() { gatewayURL = old }()
	_ = a
	g := &gateway{token: "t", intents: 1, onEvent: func(string, json.RawMessage) {}, onStatus: func(s, m string) { mu.Lock(); gotStatus, gotMsg = s, m; mu.Unlock() }}
	done := make(chan struct{})
	go func() { g.run(t.Context()); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("run must stop on a fatal close code")
	}
	mu.Lock()
	defer mu.Unlock()
	if gotStatus != "error" || !strings.Contains(gotMsg, "Intent") {
		t.Fatalf("status=%q msg=%q", gotStatus, gotMsg)
	}
}

func TestSecurityGuards(t *testing.T) {
	g := newRig(t)
	req, _ := http.NewRequest("GET", g.base+"api/state", nil)
	req.Host = "evil.example"
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != 403 {
		t.Errorf("foreign Host must be 403, got %d", resp.StatusCode)
	}
	if resp, _ := http.Get(g.ts.URL + "/wrong/api/state"); resp.StatusCode != 404 {
		t.Errorf("wrong secret must be 404, got %d", resp.StatusCode)
	}
	if resp, _ := http.Post(g.base+"api/login", "application/json", strings.NewReader(goodTok)); resp.StatusCode != 403 {
		t.Errorf("POST without X-BD must be 403, got %d", resp.StatusCode)
	}
	if resp, _ := http.Get(g.base + "api/login"); resp.StatusCode != 403 {
		t.Errorf("GET login must be 403, got %d", resp.StatusCode)
	}
	resp, _ := http.Get(g.base)
	page, _ := io.ReadAll(resp.Body)
	csp := resp.Header.Get("Content-Security-Policy")
	if resp.StatusCode != 200 || !strings.Contains(string(page), "BotDeck") || !strings.Contains(csp, "connect-src 'self'") || !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Errorf("index/CSP wrong: %d %q", resp.StatusCode, csp)
	}
}

func TestTokenNeverLeavesInResponses(t *testing.T) {
	g := newRig(t)
	g.post("login", goodTok)
	g.waitFor("ready", func() bool { s, _, _ := g.state(); return s == "ready" })
	resp, _ := http.Get(g.base + "api/state")
	b, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(b), "good-token") {
		t.Fatal("token appeared in /api/state")
	}
	if got := sanitizeErr(fmt.Errorf("dial failed for good-token-0123456789abcdef"), "good-token-0123456789abcdef"); strings.Contains(got, "good-token") {
		t.Fatalf("sanitizeErr leaked token: %s", got)
	}
}

func TestMarkdownIsEscapedInStateEvents(t *testing.T) {
	// The server never builds HTML; it forwards JSON, and the page escapes before formatting.
	h := string(indexHTML)
	if !strings.Contains(h, "let s = esc(text);") {
		t.Fatal("markdown renderer must escape input first")
	}
	if strings.Contains(h, "eval(") || strings.Contains(h, "document.write") {
		t.Fatal("page must not use eval/document.write")
	}
}

// TestServeForBrowser keeps the real app, wired to the fake Discord, running so
// a real browser can be driven against it. Skipped unless BOTDECK_SERVE is set.
func TestServeForBrowser(t *testing.T) {
	if testing.Short() || os.Getenv("BOTDECK_SERVE") == "" {
		t.Skip("set BOTDECK_SERVE=1")
	}
	g := newRig(t)
	fmt.Println("URL=" + g.base)
	os.WriteFile(os.Getenv("BOTDECK_SERVE"), []byte(g.base), 0o644)
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(os.Getenv("BOTDECK_SERVE") + ".stop"); err == nil {
			return
		}
		if raw, err := os.ReadFile(os.Getenv("BOTDECK_SERVE") + ".push"); err == nil {
			os.Remove(os.Getenv("BOTDECK_SERVE") + ".push")
			g.f.pushNext <- string(raw)
		}
		if _, err := os.Stat(os.Getenv("BOTDECK_SERVE") + ".dump"); err == nil {
			os.Remove(os.Getenv("BOTDECK_SERVE") + ".dump")
			g.f.mu.Lock()
			b, _ := json.Marshal(map[string]any{"sent": g.f.sent, "calls": g.f.calls, "uploads": g.f.uploads})
			g.f.mu.Unlock()
			os.WriteFile(os.Getenv("BOTDECK_SERVE")+".dumped", b, 0o644)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestEmojisAndRolesInSnapshot(t *testing.T) {
	g := newRig(t)
	g.post("login", goodTok)
	g.waitFor("ready", func() bool { _, _, sn := g.state(); return len(sn.Guilds) == 1 })
	_, _, sn := g.state()
	gd := sn.Guilds[0]
	if len(gd.Emojis) != 1 || gd.Emojis[0].Name != "party" || !gd.Emojis[0].Animated {
		t.Fatalf("emojis (unavailable ones must be hidden): %+v", gd.Emojis)
	}
	if len(gd.Roles) != 1 || gd.Roles[0].Color != 16711680 {
		t.Fatalf("roles: %+v", gd.Roles)
	}
	g.f.pushNext <- `{"op":0,"s":3,"t":"GUILD_EMOJIS_UPDATE","d":{"guild_id":"10","emojis":[{"id":"501","name":"party"},{"id":"503","name":"new"}]}}`
	g.waitFor("emoji update", func() bool { _, _, sn := g.state(); return len(sn.Guilds[0].Emojis) == 2 })
}

func TestReactEditTypingDM(t *testing.T) {
	g := newRig(t)
	g.post("login", goodTok)
	g.waitFor("ready", func() bool { s, _, _ := g.state(); return s == "ready" })

	if c, _ := g.post("react", `{"channel":"21","id":"901","emoji":"party:501","on":true}`); c != 200 {
		t.Fatalf("react custom: %d", c)
	}
	if c, _ := g.post("react", `{"channel":"21","id":"901","emoji":"\ud83d\udc4d","on":false}`); c != 200 {
		t.Fatalf("react unicode off: %d", c)
	}
	for _, bad := range []string{`{"channel":"21","id":"901","emoji":"../x","on":true}`, `{"channel":"21","id":"901","emoji":"a/b","on":true}`, `{"channel":"21","id":"x","emoji":"party:501","on":true}`, `{"channel":"21","id":"901","emoji":"","on":true}`} {
		if c, _ := g.post("react", bad); c != 400 {
			t.Errorf("%s should be 400, got %d", bad, c)
		}
	}
	if c, _ := g.post("edit", `{"channel":"21","id":"901","content":"new text"}`); c != 200 {
		t.Fatalf("edit: %d", c)
	}
	if c, _ := g.post("edit", `{"channel":"21","id":"901","content":" "}`); c != 400 {
		t.Fatalf("empty edit: %d", c)
	}
	if c, _ := g.post("typing", `{"channel":"21"}`); c != 200 {
		t.Fatalf("typing: %d", c)
	}
	c, m := g.post("dm", `{"user":"5"}`)
	if c != 200 || m["id"] != "dm-5" {
		t.Fatalf("dm: %d %v", c, m)
	}
	g.f.mu.Lock()
	defer g.f.mu.Unlock()
	want := []string{"PUT /api/v10/channels/21/messages/901/reactions/party:501/@me", "DELETE /api/v10/channels/21/messages/901/reactions/%F0%9F%91%8D/@me", "PATCH /api/v10/channels/21/messages/901 new text", "TYPING /api/v10/channels/21/typing"}
	if fmt.Sprint(g.f.calls) != fmt.Sprint(want) {
		t.Fatalf("calls:\n got %v\nwant %v", g.f.calls, want)
	}
}

func TestMembers(t *testing.T) {
	g := newRig(t)
	g.post("login", goodTok)
	g.waitFor("ready", func() bool { s, _, _ := g.state(); return s == "ready" })
	resp, _ := http.Get(g.base + "api/members?guild=10")
	var ms []map[string]any
	json.NewDecoder(resp.Body).Decode(&ms)
	if resp.StatusCode != 200 || len(ms) != 1 {
		t.Fatalf("members: %d %v", resp.StatusCode, ms)
	}
	resp, _ = http.Get(g.base + "api/members?guild=403")
	var e map[string]string
	json.NewDecoder(resp.Body).Decode(&e)
	if resp.StatusCode != 403 || !strings.Contains(e["error"], "Intent") {
		t.Fatalf("missing intent should explain itself: %d %v", resp.StatusCode, e)
	}
	if resp, _ = http.Get(g.base + "api/members?guild=1/../2"); resp.StatusCode != 400 {
		t.Fatalf("bad id: %d", resp.StatusCode)
	}
}

func upload(g *rig, fields map[string]string, files map[string]string) (int, map[string]any) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		mw.WriteField(k, v)
	}
	for name, data := range files {
		fw, _ := mw.CreateFormFile("files", name)
		fw.Write([]byte(data))
	}
	mw.Close()
	req, _ := http.NewRequest("POST", g.base+"api/upload", &buf)
	req.Header.Set("X-BD", "1")
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		g.t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

func TestUpload(t *testing.T) {
	g := newRig(t)
	g.post("login", goodTok)
	g.waitFor("ready", func() bool { s, _, _ := g.state(); return s == "ready" })
	c, _ := upload(g, map[string]string{"channel": "21", "content": "look", "replyTo": "901"}, map[string]string{"../../evil\"name.txt": "hello file"})
	if c != 200 {
		t.Fatalf("upload: %d", c)
	}
	g.f.mu.Lock()
	up := g.f.uploads[0]
	g.f.mu.Unlock()
	pj := up["payload"].(map[string]any)
	files := up["files"].([]string)
	if pj["content"] != "look" || pj["message_reference"].(map[string]any)["message_id"] != "901" {
		t.Fatalf("payload: %v", pj)
	}
	if len(files) != 1 || files[0] != "files[0]=evil_name.txt:hello file" {
		t.Fatalf("file name must be sanitised and content intact: %v", files)
	}
	if up["_path"] != "/api/v10/channels/21/messages" {
		t.Fatalf("path %v", up["_path"])
	}
	if c, _ := upload(g, map[string]string{"channel": "21"}, nil); c != 400 {
		t.Fatalf("no files must be 400, got %d", c)
	}
	if c, _ := upload(g, map[string]string{"channel": "../x"}, map[string]string{"a.txt": "x"}); c != 400 {
		t.Fatalf("bad channel must be 400, got %d", c)
	}
	big := strings.Repeat("x", 26<<20)
	if c, _ := upload(g, map[string]string{"channel": "21"}, map[string]string{"big.bin": big}); c != 413 {
		t.Fatalf("oversize must be 413, got %d", c)
	}
}

func TestSendEmbedsAreSanitised(t *testing.T) {
	g := newRig(t)
	g.post("login", goodTok)
	g.waitFor("ready", func() bool { s, _, _ := g.state(); return s == "ready" })
	ok := `{"channel":"21","content":"","embeds":[{"title":"T","description":"D","color":255,"evil":"x","footer":{"text":"f","bogus":1},"image":{"url":"https://a.example/i.png"},"fields":[{"name":"n","value":"v","inline":true}]}]}`
	if code, b := g.post("send", ok); code != 200 {
		t.Fatalf("embed send: %d %s", code, b)
	}
	g.f.mu.Lock()
	sent := g.f.sent[len(g.f.sent)-1]
	g.f.mu.Unlock()
	e := sent["embeds"].([]any)[0].(map[string]any)
	if _, has := e["evil"]; has || e["title"] != "T" || e["footer"].(map[string]any)["text"] != "f" {
		t.Fatalf("embed not rebuilt cleanly: %v", e)
	}
	if _, has := e["footer"].(map[string]any)["bogus"]; has {
		t.Fatal("unknown nested key forwarded")
	}
	for _, bad := range []string{
		`{"channel":"21","embeds":[{"image":{"url":"javascript:alert(1)"}}]}`,
		`{"channel":"21","embeds":[{"title":"` + strings.Repeat("x", 257) + `"}]}`,
		`{"channel":"21","embeds":[{}]}`,
		`{"channel":"21","embeds":[{"fields":[{"name":"","value":"v"}]}]}`,
	} {
		if code, _ := g.post("send", bad); code != 400 {
			t.Errorf("should reject %.60s..., got %d", bad, code)
		}
	}
}
