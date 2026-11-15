package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestServerModeGate(t *testing.T) {
	a := newApp("sec")
	a.serverMode = true
	g := newGate("correct-horse-battery", "sec", true)
	srv := httptest.NewServer(g.wrap(a.handler()))
	defer srv.Close()
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	// no cookie: app and api are closed
	for _, p := range []string{"/sec/", "/sec/api/state", "/other"} {
		r, _ := c.Get(srv.URL + p)
		if r.StatusCode == 200 {
			t.Fatalf("%s must not be open without login", p)
		}
	}
	// wrong password
	r, _ := c.PostForm(srv.URL+"/login", url.Values{"password": {"nope"}})
	if r.StatusCode != 401 {
		t.Fatalf("wrong password got %d", r.StatusCode)
	}
	// right password
	r, _ = c.PostForm(srv.URL+"/login", url.Values{"password": {"correct-horse-battery"}})
	if r.StatusCode != 303 || len(r.Cookies()) != 1 || !r.Cookies()[0].HttpOnly {
		t.Fatalf("login failed: %d %v", r.StatusCode, r.Cookies())
	}
	req, _ := http.NewRequest("GET", srv.URL+"/sec/api/state", nil)
	req.AddCookie(r.Cookies()[0])
	r2, _ := c.Do(req)
	if r2.StatusCode != 200 {
		t.Fatalf("authed state got %d", r2.StatusCode)
	}
	// forged cookie
	req.Header.Set("Cookie", cookieName+"=forged")
	r3, _ := c.Do(req)
	if r3.StatusCode == 200 {
		t.Fatal("forged cookie accepted")
	}
}

func TestServerModeLockout(t *testing.T) {
	g := newGate("correct-horse-battery", "sec", true)
	h := g.wrap(http.NotFoundHandler())
	var last int
	for i := 0; i < 10; i++ {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/login", strings.NewReader("password=bad"))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		h.ServeHTTP(w, r)
		last = w.Code
	}
	if last != 429 {
		t.Fatalf("expected lockout 429, got %d", last)
	}
}

func TestHTTPSRequired(t *testing.T) {
	g := newGate("correct-horse-battery", "sec", false)
	w := httptest.NewRecorder()
	g.wrap(http.NotFoundHandler()).ServeHTTP(w, httptest.NewRequest("POST", "/login", strings.NewReader("password=x")))
	if w.Code != 403 {
		t.Fatalf("plain http login must be refused, got %d", w.Code)
	}
}
