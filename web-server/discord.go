package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"
)

var apiBase = "https://discord.com/api/v10"

var snowflake = regexp.MustCompile(`^[0-9]{1,20}$`)

// discord is a minimal REST client. The token lives only here, in memory.
type discord struct {
	token string
	hc    *http.Client
}

func newDiscord(token string) *discord {
	return &discord{token: token, hc: &http.Client{Timeout: 30 * time.Second}}
}

// do performs a request and returns status and raw body. A 429 is waited out once.
func (d *discord) do(ctx context.Context, method, path string, body any) (int, []byte, error) {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return 0, nil, err
		}
	}
	return d.doBytes(ctx, method, path, "application/json", payload)
}

// doBytes is do with a ready-made body (used for multipart uploads).
func (d *discord) doBytes(ctx context.Context, method, path, contentType string, payload []byte) (int, []byte, error) {
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, apiBase+path, bytes.NewReader(payload))
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Authorization", "Bot "+d.token)
		req.Header.Set("User-Agent", "DiscordBot (botdeck, 1.0)")
		if payload != nil {
			req.Header.Set("Content-Type", contentType)
		}
		resp, err := d.hc.Do(req)
		if err != nil {
			return 0, nil, err
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		resp.Body.Close()
		if err != nil {
			return 0, nil, err
		}
		if resp.StatusCode == http.StatusTooManyRequests && attempt == 0 {
			wait := 1.0
			var rl struct {
				RetryAfter float64 `json:"retry_after"`
			}
			if json.Unmarshal(b, &rl) == nil && rl.RetryAfter > 0 {
				wait = rl.RetryAfter
			} else if v, e := strconv.ParseFloat(resp.Header.Get("Retry-After"), 64); e == nil {
				wait = v
			}
			if wait > 10 {
				return resp.StatusCode, b, nil
			}
			select {
			case <-ctx.Done():
				return 0, nil, ctx.Err()
			case <-time.After(time.Duration(wait * float64(time.Second))):
			}
			continue
		}
		return resp.StatusCode, b, nil
	}
}

// apiError turns a Discord error body into a short message.
func apiError(code int, body []byte) string {
	var e struct {
		Message string `json:"message"`
	}
	json.Unmarshal(body, &e)
	switch code {
	case 401:
		return "โทเคนไม่ถูกต้อง (401)"
	case 403:
		return "บอทไม่มีสิทธิ์ทำสิ่งนี้ในช่องนี้ (403)"
	case 404:
		return "ไม่พบข้อมูล (404)"
	}
	if e.Message != "" {
		return fmt.Sprintf("%s (%d)", e.Message, code)
	}
	return fmt.Sprintf("Discord ตอบ %d", code)
}

// ---- in-memory view of what the gateway has told us ----

type channel struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     int    `json:"type"`
	ParentID string `json:"parent_id"`
	Position int    `json:"position"`
	Topic    string `json:"topic"`
}

type emoji struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Animated  bool   `json:"animated"`
	Available *bool  `json:"available,omitempty"`
}

type role struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Color    int    `json:"color"`
	Position int    `json:"position"`
}

type guild struct {
	ID       string             `json:"id"`
	Name     string             `json:"name"`
	Icon     string             `json:"icon"`
	Channels map[string]channel `json:"-"`
	Emojis   []emoji            `json:"-"`
	Roles    []role             `json:"-"`
}

type user struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
}

type store struct {
	mu     sync.RWMutex
	me     user
	guilds map[string]*guild
}

func newStore() *store { return &store{guilds: map[string]*guild{}} }

func (s *store) reset(me user) {
	s.mu.Lock()
	s.me, s.guilds = me, map[string]*guild{}
	s.mu.Unlock()
}

type guildOut struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Icon     string    `json:"icon"`
	Channels []channel `json:"channels"`
	Emojis   []emoji   `json:"emojis"`
	Roles    []role    `json:"roles"`
}

type snapshot struct {
	Me     user       `json:"me"`
	Guilds []guildOut `json:"guilds"`
}

func (s *store) snapshot() snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := snapshot{Me: s.me, Guilds: []guildOut{}}
	for _, g := range s.guilds {
		chs := make([]channel, 0, len(g.Channels))
		for _, c := range g.Channels {
			chs = append(chs, c)
		}
		sort.Slice(chs, func(i, j int) bool {
			if chs[i].Position != chs[j].Position {
				return chs[i].Position < chs[j].Position
			}
			return chs[i].ID < chs[j].ID
		})
		emojis, roles := g.Emojis, g.Roles
		if emojis == nil {
			emojis = []emoji{}
		}
		if roles == nil {
			roles = []role{}
		}
		out.Guilds = append(out.Guilds, guildOut{ID: g.ID, Name: g.Name, Icon: g.Icon, Channels: chs, Emojis: emojis, Roles: roles})
	}
	sort.Slice(out.Guilds, func(i, j int) bool { return out.Guilds[i].Name < out.Guilds[j].Name })
	return out
}

// apply folds a gateway event into the store and reports whether the UI's
// snapshot changed.
func (s *store) apply(t string, d json.RawMessage) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch t {
	case "READY":
		var r struct {
			User   user `json:"user"`
			Guilds []struct {
				ID string `json:"id"`
			} `json:"guilds"`
		}
		if json.Unmarshal(d, &r) != nil {
			return false
		}
		s.me = r.User
		return true
	case "GUILD_CREATE":
		var g struct {
			ID       string    `json:"id"`
			Name     string    `json:"name"`
			Icon     string    `json:"icon"`
			Channels []channel `json:"channels"`
			Emojis   []emoji   `json:"emojis"`
			Roles    []role    `json:"roles"`
		}
		if json.Unmarshal(d, &g) != nil || g.ID == "" {
			return false
		}
		ng := &guild{ID: g.ID, Name: g.Name, Icon: g.Icon, Channels: map[string]channel{}, Roles: g.Roles}
		for _, e := range g.Emojis {
			if e.ID != "" && (e.Available == nil || *e.Available) {
				ng.Emojis = append(ng.Emojis, e)
			}
		}
		for _, c := range g.Channels {
			ng.Channels[c.ID] = c
		}
		s.guilds[g.ID] = ng
		return true
	case "GUILD_EMOJIS_UPDATE":
		var u struct {
			GuildID string  `json:"guild_id"`
			Emojis  []emoji `json:"emojis"`
		}
		if json.Unmarshal(d, &u) != nil || s.guilds[u.GuildID] == nil {
			return false
		}
		var list []emoji
		for _, e := range u.Emojis {
			if e.ID != "" && (e.Available == nil || *e.Available) {
				list = append(list, e)
			}
		}
		s.guilds[u.GuildID].Emojis = list
		return true
	case "GUILD_UPDATE":
		var g guild
		if json.Unmarshal(d, &g) != nil {
			return false
		}
		if cur := s.guilds[g.ID]; cur != nil {
			cur.Name, cur.Icon = g.Name, g.Icon
			return true
		}
	case "GUILD_DELETE":
		var g struct {
			ID          string `json:"id"`
			Unavailable bool   `json:"unavailable"`
		}
		if json.Unmarshal(d, &g) == nil && !g.Unavailable {
			delete(s.guilds, g.ID)
			return true
		}
	case "CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE":
		var c struct {
			channel
			GuildID string `json:"guild_id"`
		}
		if json.Unmarshal(d, &c) != nil {
			return false
		}
		g := s.guilds[c.GuildID]
		if g == nil {
			return false
		}
		if t == "CHANNEL_DELETE" {
			delete(g.Channels, c.ID)
		} else {
			g.Channels[c.ID] = c.channel
		}
		return true
	}
	return false
}
