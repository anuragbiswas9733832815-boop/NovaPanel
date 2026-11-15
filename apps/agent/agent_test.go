package main

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRequestSignatureBindsPayloadAndRoute(t *testing.T) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil { t.Fatal(err) }
	body := []byte(`{"operation":"website.create"}`)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil { t.Fatal(err) }
	nonce := hex.EncodeToString(nonceBytes)
	signature := requestSignature(secret, "POST", "/v1/operations", timestamp, nonce, body)
	if got := requestSignature(secret, "POST", "/v1/operations", timestamp, nonce, body); !equalBytes(signature, got) { t.Fatal("same signed request did not produce a stable HMAC") }
	if equalBytes(signature, requestSignature(secret, "POST", "/v1/operations", timestamp, nonce, []byte(`{}`))) { t.Fatal("payload was not covered by the signature") }
	if equalBytes(signature, requestSignature(secret, "GET", "/v1/operations", timestamp, nonce, body)) { t.Fatal("method was not covered by the signature") }
}

func TestReplayCacheRejectsNonceReuse(t *testing.T) {
	cache := newReplayCache(4)
	until := time.Now().Add(time.Minute)
	if !cache.Use("nonce-1", until) { t.Fatal("first nonce should be accepted") }
	if cache.Use("nonce-1", until) { t.Fatal("reused nonce must be rejected") }
}

func TestSafeRelativeBlocksTraversal(t *testing.T) {
	for _, value := range []string{"../etc/passwd", "/etc/passwd", `a\\..\\secret`, "a/../../secret", ".."} {
		if _, err := safeRelative(value, false); err == nil { t.Errorf("unsafe path %q accepted", value) }
	}
	if got, err := safeRelative("assets/site.css", false); err != nil || got != "assets/site.css" { t.Fatalf("valid path rejected: %q, %v", got, err) }
	if got, err := safeRelative(".", true); err != nil || got != "." { t.Fatalf("site root listing rejected: %q, %v", got, err) }
}

func TestDomainValidationRejectsConfigInjection(t *testing.T) {
	for _, domain := range []string{"example.com", "store.example.co.uk"} { if !validDomain.MatchString(domain) { t.Errorf("valid domain %q rejected", domain) } }
	for _, domain := range []string{"example.com;return 200", "*.example.com", "-bad.example.com", "example..com"} { if validDomain.MatchString(domain) { t.Errorf("invalid domain %q accepted", domain) } }
}

func TestSiteConfigTLSKeepsHTTPChallengeAndRedirectsOtherRequests(t *testing.T) {
	a := &agent{config: config{siteRootPath: "/srv/nova/sites"}}
	httpConfig := a.nginxConfig("site_123", "www.example.com", false)
	if !strings.Contains(httpConfig, "listen 80;") || strings.Contains(httpConfig, "listen 443") { t.Fatal("plain static site should only expose its HTTP virtual host") }
	tlsConfig := a.nginxConfig("site_123", "www.example.com", true)
	for _, expected := range []string{"listen 80;", "listen 443 ssl http2;", "location ^~ /.well-known/acme-challenge/", "return 301 https://$host$request_uri;", "/etc/letsencrypt/live/nova-site_123/fullchain.pem", "Strict-Transport-Security", "return 404;"} {
		if !strings.Contains(tlsConfig, expected) { t.Errorf("TLS site config does not contain %q", expected) }
	}
	a.config.acmeStaging = true
	stagingConfig := a.nginxConfig("site_123", "www.example.com", true)
	if !strings.Contains(stagingConfig, "/etc/letsencrypt/live/nova-site_123-staging/fullchain.pem") { t.Fatal("staging certificates must use a separate lineage") }
}

func equalBytes(a, b []byte) bool { if len(a) != len(b) { return false }; var diff byte; for i := range a { diff |= a[i] ^ b[i] }; return diff == 0 }
