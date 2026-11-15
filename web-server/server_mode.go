package main

// Server mode: run BotDeck on a hosting panel and use it from any browser.
// Everything is gated by one password; the bot token is only ever kept in memory.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"html"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const cookieName = "bd_session"

type gate struct {
	mu        sync.Mutex
	password  string
	allowHTTP bool
	sessions  map[string]time.Time
	fails     int
	lockUntil time.Time
	failStart time.Time
	secret    string
}

func newGate(password, secret string, allowHTTP bool) *gate {
	return &gate{password: password, secret: secret, allowHTTP: allowHTTP, sessions: map[string]time.Time{}}
}

func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func (g *gate) valid(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	exp, ok := g.sessions[c.Value]
	if !ok || time.Now().After(exp) {
		delete(g.sessions, c.Value)
		return false
	}
	return true
}

const loginPage = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>BotDeck</title><style>body{font-family:system-ui,sans-serif;background:#1e1f22;color:#dbdee1;display:grid;place-items:center;height:100vh;margin:0}
form{background:#2b2d31;padding:28px;border-radius:10px;width:min(320px,90vw)}input,button{width:100%%;box-sizing:border-box;padding:10px;margin-top:12px;border-radius:6px;border:0;font-size:15px}
input{background:#1e1f22;color:#dbdee1}button{background:#5865f2;color:#fff;cursor:pointer}p{color:#f23f43;min-height:1em;margin:8px 0 0}</style>
<form method=post action=/login><h2>BotDeck</h2><input type=password name=password placeholder="Password" autofocus required>
<button>Sign in</button><p>%s</p></form>`

func (g *gate) wrap(inner http.Handler) http.Handler {
	prefix := "/" + g.secret + "/"
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		if !g.allowHTTP && !isHTTPS(r) {
			http.Error(w, "HTTPS required (set BOTDECK_ALLOW_HTTP=1 to override at your own risk)", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodPost {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		g.mu.Lock()
		if time.Now().Before(g.lockUntil) {
			g.mu.Unlock()
			http.Error(w, "too many attempts, try again later", http.StatusTooManyRequests)
			return
		}
		g.mu.Unlock()
		r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
		_ = r.ParseForm()
		if subtle.ConstantTimeCompare([]byte(r.PostForm.Get("password")), []byte(g.password)) != 1 {
			g.mu.Lock()
			if time.Since(g.failStart) > 10*time.Minute {
				g.fails, g.failStart = 0, time.Now()
			}
			g.fails++
			if g.fails >= 8 {
				g.lockUntil = time.Now().Add(10 * time.Minute)
				g.fails = 0
			}
			g.mu.Unlock()
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprintf(w, loginPage, html.EscapeString("Wrong password"))
			return
		}
		b := make([]byte, 32)
		rand.Read(b)
		tok := hex.EncodeToString(b)
		g.mu.Lock()
		g.sessions[tok] = time.Now().Add(12 * time.Hour)
		g.mu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: tok, Path: "/", HttpOnly: true,
			Secure: isHTTPS(r), SameSite: http.SameSiteStrictMode, MaxAge: 12 * 3600})
		http.Redirect(w, r, prefix, http.StatusSeeOther)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, prefix) {
			if !g.valid(r) {
				if r.URL.Path == prefix {
					http.Redirect(w, r, "/", http.StatusSeeOther)
					return
				}
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			inner.ServeHTTP(w, r)
			return
		}
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if g.valid(r) {
			http.Redirect(w, r, prefix, http.StatusSeeOther)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Frame-Options", "DENY")
		fmt.Fprintf(w, loginPage, "")
	})
	return mux
}

func serverPort() string {
	for _, k := range []string{"BOTDECK_PORT", "PORT", "SERVER_PORT"} {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return "8080"
}

func runServer() {
	pw := os.Getenv("BOTDECK_PASSWORD")
	if len(pw) < 10 {
		fmt.Fprintln(os.Stderr, "BOTDECK_PASSWORD must be set to at least 10 characters")
		os.Exit(1)
	}
	sb := make([]byte, 16)
	rand.Read(sb)
	secret := hex.EncodeToString(sb)
	a := newApp(secret)
	a.serverMode = true
	g := newGate(pw, secret, os.Getenv("BOTDECK_ALLOW_HTTP") == "1")
	ln, err := net.Listen("tcp", "0.0.0.0:"+serverPort())
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot listen:", err)
		os.Exit(1)
	}
	fmt.Println("BotDeck server listening on", ln.Addr())
	if g.allowHTTP {
		fmt.Println("WARNING: plain HTTP allowed; password and bot token can be read on the network")
	}
	srv := &http.Server{Handler: g.wrap(a.handler()), ReadHeaderTimeout: 10 * time.Second}
	if err := srv.Serve(ln); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
