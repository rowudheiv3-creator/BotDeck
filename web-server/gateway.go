package main

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// Overridable so tests can point the client at a fake Discord.
var (
	gatewayURL    = "wss://gateway.discord.gg/?v=10&encoding=json"
	reconnectBase = time.Second
)

const (
	intentMembers        = 1 << 1 // privileged: must be enabled in the Developer Portal
	intentDMs            = 1<<12 | 1<<13
	intentGuilds         = 1 << 0
	intentGuildMessages  = 1 << 9
	intentGuildReactions = 1 << 10
	intentMessageContent = 1 << 15
	gatewayVersionQuery  = "/?v=10&encoding=json"
	closeZombie          = 4000
	maxReconnectBackoff  = 30 * time.Second
)

type gwMsg struct {
	Op int             `json:"op"`
	D  json.RawMessage `json:"d"`
	S  *int64          `json:"s"`
	T  string          `json:"t"`
}

type gateway struct {
	token    string
	intents  int
	onEvent  func(t string, d json.RawMessage)
	onStatus func(status, msg string)

	sessionID string
	resumeURL string
	seq       atomic.Int64 // 0 = none yet
}

// fatalClose maps close codes that retrying can never fix to a message for the person.
var fatalClose = map[int]string{
	4004: "โทเคนไม่ถูกต้อง (Authentication failed)",
	4010: "ค่า shard ไม่ถูกต้อง",
	4011: "ต้องใช้ sharding",
	4012: "เวอร์ชัน API ไม่ถูกต้อง",
	4013: "ค่า intents ไม่ถูกต้อง",
	4014: "ยังไม่ได้เปิด Privileged Intent ในหน้า Developer Portal (Bot → Privileged Gateway Intents → Message Content) ลองปิดตัวเลือก Message Content ตอนล็อกอิน หรือไปเปิดมันก่อน",
}

func (g *gateway) run(ctx context.Context) {
	backoff := reconnectBase
	for ctx.Err() == nil {
		ready, err := g.session(ctx)
		if ctx.Err() != nil {
			return
		}
		var ce *closeError
		if errors.As(err, &ce) {
			if msg, fatal := fatalClose[ce.Code]; fatal {
				g.onStatus("error", msg)
				return
			}
			if ce.Code == 4007 || ce.Code == 4009 {
				g.sessionID = ""
			}
		}
		if ready {
			backoff = reconnectBase
		}
		g.onStatus("connecting", "")
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxReconnectBackoff)
	}
}

// session runs one connection. ready reports whether it got as far as READY/RESUMED.
func (g *gateway) session(ctx context.Context) (ready bool, err error) {
	url := gatewayURL
	if g.sessionID != "" && g.resumeURL != "" {
		url = g.resumeURL
	}
	conn, err := wsDial(ctx, url)
	if err != nil {
		return false, err
	}
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { <-sctx.Done(); conn.Close() }()

	raw, err := conn.ReadMessage()
	if err != nil {
		return false, err
	}
	var hello gwMsg
	if err := json.Unmarshal(raw, &hello); err != nil || hello.Op != 10 {
		return false, errors.New("gateway did not say hello")
	}
	var hd struct {
		Interval float64 `json:"heartbeat_interval"`
	}
	json.Unmarshal(hello.D, &hd)
	interval := time.Duration(hd.Interval * float64(time.Millisecond))
	if interval <= 0 {
		interval = 41250 * time.Millisecond
	}

	var acked atomic.Bool
	acked.Store(true)
	var hbMu sync.Mutex
	beat := func() {
		hbMu.Lock()
		defer hbMu.Unlock()
		var d any
		if s := g.seq.Load(); s != 0 {
			d = s
		}
		b, _ := json.Marshal(map[string]any{"op": 1, "d": d})
		conn.WriteText(b)
	}
	go func() {
		// First beat after a random fraction of the interval, as the docs ask.
		t := time.NewTimer(time.Duration(rand.Float64() * float64(interval)))
		defer t.Stop()
		for {
			select {
			case <-sctx.Done():
				return
			case <-t.C:
			}
			if !acked.Swap(false) { // previous beat never acknowledged: zombie connection
				conn.CloseWith(closeZombie)
				return
			}
			beat()
			t.Reset(interval)
		}
	}()

	if g.sessionID != "" {
		b, _ := json.Marshal(map[string]any{"op": 6, "d": map[string]any{
			"token": g.token, "session_id": g.sessionID, "seq": g.seq.Load(),
		}})
		err = conn.WriteText(b)
	} else {
		g.seq.Store(0)
		b, _ := json.Marshal(map[string]any{"op": 2, "d": map[string]any{
			"token":   g.token,
			"intents": g.intents,
			"properties": map[string]string{
				"os": runtime.GOOS, "browser": "botdeck", "device": "botdeck",
			},
		}})
		err = conn.WriteText(b)
	}
	if err != nil {
		return false, err
	}

	for {
		raw, err := conn.ReadMessage()
		if err != nil {
			return ready, err
		}
		var m gwMsg
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		switch m.Op {
		case 0:
			if m.S != nil {
				g.seq.Store(*m.S)
			}
			switch m.T {
			case "READY":
				var r struct {
					SessionID string `json:"session_id"`
					ResumeURL string `json:"resume_gateway_url"`
				}
				json.Unmarshal(m.D, &r)
				g.sessionID = r.SessionID
				g.resumeURL = r.ResumeURL + gatewayVersionQuery
				if r.ResumeURL == "" {
					g.resumeURL = ""
				}
				ready = true
				g.onStatus("ready", "")
			case "RESUMED":
				ready = true
				g.onStatus("ready", "")
			}
			g.onEvent(m.T, m.D)
		case 1:
			beat()
		case 7: // server asks us to reconnect; the session stays resumable
			conn.CloseWith(closeZombie)
			return ready, errors.New("gateway asked to reconnect")
		case 9:
			var resumable bool
			json.Unmarshal(m.D, &resumable)
			if !resumable {
				g.sessionID = ""
			}
			conn.CloseWith(closeZombie)
			return ready, errors.New("invalid session")
		case 11:
			acked.Store(true)
		}
	}
}
