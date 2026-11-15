package main

// A small RFC 6455 WebSocket client written on the standard library, so the
// whole program stays one dependency-free executable.

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

const (
	wsGUID     = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	wsMaxFrame = 64 << 20 // large GUILD_CREATE payloads are several MB
)

type closeError struct {
	Code   int
	Reason string
}

func (e *closeError) Error() string { return fmt.Sprintf("websocket closed: %d %s", e.Code, e.Reason) }

type wsConn struct {
	c    net.Conn
	br   *bufio.Reader
	wmu  sync.Mutex
	mask bool // clients must mask; the test server does not
}

func wsAccept(key string) string {
	h := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h[:])
}

func wsDial(ctx context.Context, raw string) (*wsConn, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "wss" && u.Scheme != "ws") {
		return nil, fmt.Errorf("bad websocket url %q", raw)
	}
	host := u.Host
	if u.Port() == "" {
		if u.Scheme == "wss" {
			host += ":443"
		} else {
			host += ":80"
		}
	}
	d := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	nc, err := d.DialContext(ctx, "tcp", host)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "wss" {
		tc := tls.Client(nc, &tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12})
		if err := tc.HandshakeContext(ctx); err != nil {
			nc.Close()
			return nil, err
		}
		nc = tc
	}
	kb := make([]byte, 16)
	if _, err := rand.Read(kb); err != nil {
		nc.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(kb)
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: BotDeck\r\n\r\n",
		u.RequestURI(), u.Host, key)
	nc.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := io.WriteString(nc, req); err != nil {
		nc.Close()
		return nil, err
	}
	br := bufio.NewReaderSize(nc, 64*1024)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		nc.Close()
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols || resp.Header.Get("Sec-WebSocket-Accept") != wsAccept(key) {
		nc.Close()
		return nil, fmt.Errorf("websocket handshake failed: %s", resp.Status)
	}
	nc.SetDeadline(time.Time{})
	return &wsConn{c: nc, br: br, mask: true}, nil
}

func (w *wsConn) readFrame() (op byte, fin bool, payload []byte, err error) {
	var h [2]byte
	if _, err = io.ReadFull(w.br, h[:]); err != nil {
		return
	}
	fin, op = h[0]&0x80 != 0, h[0]&0x0f
	masked := h[1]&0x80 != 0
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var b [2]byte
		if _, err = io.ReadFull(w.br, b[:]); err != nil {
			return
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err = io.ReadFull(w.br, b[:]); err != nil {
			return
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	if n > wsMaxFrame {
		err = errors.New("websocket frame too large")
		return
	}
	var mk [4]byte
	if masked {
		if _, err = io.ReadFull(w.br, mk[:]); err != nil {
			return
		}
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(w.br, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= mk[i%4]
		}
	}
	return
}

// ReadMessage returns the next complete data message. Pings are answered, and a
// close frame comes back as *closeError.
func (w *wsConn) ReadMessage() ([]byte, error) {
	var msg []byte
	for {
		op, fin, p, err := w.readFrame()
		if err != nil {
			return nil, err
		}
		switch op {
		case 0x8:
			ce := &closeError{Code: 1005}
			if len(p) >= 2 {
				ce.Code, ce.Reason = int(binary.BigEndian.Uint16(p)), string(p[2:])
			}
			w.writeFrame(0x8, p[:min(len(p), 2)])
			return nil, ce
		case 0x9:
			w.writeFrame(0xA, p)
		case 0xA:
		case 0x0, 0x1, 0x2:
			msg = append(msg, p...)
			if len(msg) > wsMaxFrame {
				return nil, errors.New("websocket message too large")
			}
			if fin {
				return msg, nil
			}
		}
	}
}

func (w *wsConn) writeFrame(op byte, payload []byte) error {
	n := len(payload)
	buf := make([]byte, 0, n+14)
	buf = append(buf, 0x80|op)
	var mb byte
	if w.mask {
		mb = 0x80
	}
	switch {
	case n < 126:
		buf = append(buf, mb|byte(n))
	case n <= 0xffff:
		buf = append(buf, mb|126, byte(n>>8), byte(n))
	default:
		buf = append(buf, mb|127)
		buf = binary.BigEndian.AppendUint64(buf, uint64(n))
	}
	if w.mask {
		var mk [4]byte
		if _, err := rand.Read(mk[:]); err != nil {
			return err
		}
		buf = append(buf, mk[:]...)
		for i, b := range payload {
			buf = append(buf, b^mk[i%4])
		}
	} else {
		buf = append(buf, payload...)
	}
	w.wmu.Lock()
	defer w.wmu.Unlock()
	w.c.SetWriteDeadline(time.Now().Add(15 * time.Second))
	_, err := w.c.Write(buf)
	return err
}

func (w *wsConn) WriteText(b []byte) error { return w.writeFrame(0x1, b) }

// CloseWith sends a close frame with code (4000+ keeps a Discord session
// resumable; 1000/1001 would invalidate it) and drops the connection.
func (w *wsConn) CloseWith(code int) {
	p := binary.BigEndian.AppendUint16(nil, uint16(code))
	w.writeFrame(0x8, p)
	w.c.Close()
}

func (w *wsConn) Close() { w.c.Close() }
