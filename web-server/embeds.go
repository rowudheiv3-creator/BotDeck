package main

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// cleanEmbeds rebuilds each embed from a fixed set of fields and limits, so only
// what Discord documents is ever forwarded.
func cleanEmbeds(in []map[string]any) ([]map[string]any, string) {
	if len(in) == 0 {
		return nil, ""
	}
	if len(in) > 10 {
		return nil, "ใส่ embed ได้สูงสุด 10 อัน"
	}
	total := 0
	str := func(m map[string]any, k string, max int) (string, bool) {
		v, ok := m[k].(string)
		if !ok {
			return "", true
		}
		if utf8.RuneCountInString(v) > max {
			return "", false
		}
		total += utf8.RuneCountInString(v)
		return v, true
	}
	httpURL := func(v string) bool {
		return strings.HasPrefix(v, "https://") || strings.HasPrefix(v, "http://")
	}
	obj := func(e map[string]any, k string, keys map[string]int, urlKeys ...string) (map[string]any, string) {
		raw, ok := e[k].(map[string]any)
		if !ok {
			return nil, ""
		}
		out := map[string]any{}
		for key, max := range keys {
			v, ok := str(raw, key, max)
			if !ok {
				return nil, fmt.Sprintf("%s.%s ยาวเกินกำหนด", k, key)
			}
			if v != "" {
				out[key] = v
			}
		}
		for _, uk := range urlKeys {
			if v, _ := raw[uk].(string); v != "" {
				if !httpURL(v) || len(v) > 2000 {
					return nil, k + ": ลิงก์ต้องขึ้นต้นด้วย http(s)://"
				}
				out[uk] = v
			}
		}
		if len(out) == 0 {
			return nil, ""
		}
		return out, ""
	}
	res := make([]map[string]any, 0, len(in))
	for _, e := range in {
		o := map[string]any{}
		for k, max := range map[string]int{"title": 256, "description": 4096} {
			v, ok := str(e, k, max)
			if !ok {
				return nil, k + " ยาวเกินกำหนด"
			}
			if v != "" {
				o[k] = v
			}
		}
		if v, _ := e["url"].(string); v != "" {
			if !httpURL(v) {
				return nil, "url ต้องขึ้นต้นด้วย http(s)://"
			}
			o["url"] = v
		}
		if c, ok := e["color"].(float64); ok && c >= 0 && c <= 0xFFFFFF {
			o["color"] = int(c)
		}
		if ts, _ := e["timestamp"].(string); ts != "" {
			if _, err := time.Parse(time.RFC3339, ts); err != nil {
				return nil, "timestamp ไม่ถูกต้อง"
			}
			o["timestamp"] = ts
		}
		for _, spec := range []struct {
			k    string
			keys map[string]int
			urls []string
		}{
			{"footer", map[string]int{"text": 2048}, []string{"icon_url"}},
			{"author", map[string]int{"name": 256}, []string{"url", "icon_url"}},
			{"image", map[string]int{}, []string{"url"}},
			{"thumbnail", map[string]int{}, []string{"url"}},
		} {
			sub, msg := obj(e, spec.k, spec.keys, spec.urls...)
			if msg != "" {
				return nil, msg
			}
			if sub != nil {
				o[spec.k] = sub
			}
		}
		if fl, ok := e["fields"].([]any); ok {
			if len(fl) > 25 {
				return nil, "field ได้สูงสุด 25 อัน"
			}
			var fields []map[string]any
			for _, x := range fl {
				fm, _ := x.(map[string]any)
				name, ok1 := str(fm, "name", 256)
				val, ok2 := str(fm, "value", 1024)
				if !ok1 || !ok2 || name == "" || val == "" {
					return nil, "field ต้องมีชื่อและค่า (ชื่อ ≤256, ค่า ≤1024 ตัวอักษร)"
				}
				f := map[string]any{"name": name, "value": val}
				if inl, ok := fm["inline"].(bool); ok {
					f["inline"] = inl
				}
				fields = append(fields, f)
			}
			if len(fields) > 0 {
				o["fields"] = fields
			}
		}
		if len(o) == 0 {
			return nil, "embed ว่างเปล่า"
		}
		res = append(res, o)
	}
	if total > 6000 {
		return nil, "embed รวมกันยาวเกิน 6000 ตัวอักษร"
	}
	return res, ""
}
