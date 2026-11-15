package main

import (
	"sync"
	"time"
)

type replayCache struct {
	mu      sync.Mutex
	entries map[string]time.Time
	max     int
}

func newReplayCache(max int) *replayCache { return &replayCache{entries: make(map[string]time.Time), max: max} }

func (c *replayCache) Use(nonce string, expiry time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for key, until := range c.entries { if !until.After(now) { delete(c.entries, key) } }
	if _, exists := c.entries[nonce]; exists || len(c.entries) >= c.max { return false }
	c.entries[nonce] = expiry
	return true
}
