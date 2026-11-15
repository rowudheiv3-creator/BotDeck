package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"
)

func main() {
	if os.Getenv("BOTDECK_SERVER") == "1" || os.Getenv("BOTDECK_PASSWORD") != "" {
		runServer()
		return
	}
	// Loopback only: nothing outside this computer can reach the app.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		showError("เริ่มโปรแกรมไม่ได้: " + err.Error())
		os.Exit(1)
	}
	sb := make([]byte, 16)
	if _, err := rand.Read(sb); err != nil {
		showError("เริ่มโปรแกรมไม่ได้: " + err.Error())
		os.Exit(1)
	}
	secret := hex.EncodeToString(sb)
	port := ln.Addr().(*net.TCPAddr).Port

	a := newApp(secret)
	a.hosts = []string{fmt.Sprintf("127.0.0.1:%d", port), fmt.Sprintf("localhost:%d", port)}
	a.onQuit = func() { os.Exit(0) }

	// Quit by itself shortly after the browser tab is closed.
	go func() {
		for range time.Tick(5 * time.Second) {
			if a.idleFor() > 40*time.Second {
				os.Exit(0)
			}
		}
	}()

	url := fmt.Sprintf("http://127.0.0.1:%d/%s/", port, secret)
	if os.Getenv("BOTDECK_NO_BROWSER") != "" {
		fmt.Println(url)
	} else {
		openBrowser(url)
	}
	srv := &http.Server{Handler: a.handler(), ReadHeaderTimeout: 10 * time.Second}
	if err := srv.Serve(ln); err != nil {
		showError("โปรแกรมหยุดทำงาน: " + err.Error())
		os.Exit(1)
	}
}
