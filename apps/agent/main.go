// Nova Hosting node agent. It exposes a small authenticated operation allowlist only;
// no shell command or arbitrary privileged API is available.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/tls"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const agentVersion = "0.4.0"

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type config struct {
	nodeID          string
	secret          []byte
	controlURL      string
	listen           string
	siteRootPath    string
	nginxAvailable  string
	nginxEnabled    string
	tlsCert         string
	tlsKey          string
	acmeEmail       string
	acmeStaging     bool
}

type agent struct {
	config     config
	sitesRoot  *os.Root
	replays    *replayCache
	logger     *slog.Logger
}

func mustEnv(key string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		panic("required environment variable is missing: " + key)
	}
	return value
}

func loadConfig() config {
	secret, err := decodeSecret(mustEnv("NOVA_SHARED_SECRET"))
	if err != nil { panic("NOVA_SHARED_SECRET must be base64-encoded key material (minimum 32 bytes)") }
	control := strings.TrimRight(mustEnv("NOVA_CONTROL_URL"), "/")
	controlURL, urlErr := url.Parse(control)
	if urlErr != nil || controlURL.Scheme != "https" || controlURL.Host == "" || controlURL.User != nil || controlURL.RawQuery != "" || controlURL.Fragment != "" || (controlURL.Path != "" && controlURL.Path != "/") { panic("NOVA_CONTROL_URL must be an HTTPS origin without credentials or a path") }
	nodeID := mustEnv("NOVA_NODE_ID")
	if !safeID.MatchString(nodeID) { panic("NOVA_NODE_ID has invalid characters") }
	acmeEmail := mustEnv("NOVA_ACME_EMAIL")
	parsedEmail, emailErr := mail.ParseAddress(acmeEmail)
	if emailErr != nil || parsedEmail.Address != acmeEmail { panic("NOVA_ACME_EMAIL must be a single valid email address") }
	stagingValue := envOr("NOVA_ACME_STAGING", "false")
	if stagingValue != "true" && stagingValue != "false" { panic("NOVA_ACME_STAGING must be true or false") }
	root := os.Getenv("NOVA_SITE_ROOT")
	if root == "" { root = "/srv/nova/sites" }
	absRoot, err := filepath.Abs(root)
	if err != nil || absRoot == string(filepath.Separator) { panic("NOVA_SITE_ROOT must be a valid non-root directory") }
	return config{
		nodeID: nodeID, secret: secret, controlURL: control,
		listen: envOr("NOVA_LISTEN", ":8443"), siteRootPath: absRoot,
		nginxAvailable: envOr("NOVA_NGINX_AVAILABLE", "/etc/nginx/sites-available"),
		nginxEnabled: envOr("NOVA_NGINX_ENABLED", "/etc/nginx/sites-enabled"),
		tlsCert: mustEnv("NOVA_TLS_CERT"), tlsKey: mustEnv("NOVA_TLS_KEY"),
		acmeEmail: acmeEmail, acmeStaging: stagingValue == "true",
	}
}

func envOr(key, fallback string) string { if v := strings.TrimSpace(os.Getenv(key)); v != "" { return v }; return fallback }

func main() {
	if os.Geteuid() != 0 { slog.Error("node agent must run as root; keep its operation allowlist and systemd sandbox intact"); os.Exit(1) }
	cfg := loadConfig()
	if err := os.MkdirAll(cfg.siteRootPath, 0755); err != nil { slog.Error("create site root", "error", err); os.Exit(1) }
	canonicalRoot, err := filepath.EvalSymlinks(cfg.siteRootPath)
	if err != nil { slog.Error("resolve site root", "error", err); os.Exit(1) }
	if canonicalRoot != cfg.siteRootPath { slog.Error("NOVA_SITE_ROOT must not contain symlink components"); os.Exit(1) }
	root, err := os.OpenRoot(canonicalRoot)
	if err != nil { slog.Error("open confined site root", "error", err); os.Exit(1) }
	defer root.Close()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	a := &agent{config: cfg, sitesRoot: root, replays: newReplayCache(20_000), logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": agentVersion}) })
	mux.HandleFunc("POST /v1/operations", a.handleOperation)
	server := &http.Server{Addr: cfg.listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 165 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	go a.heartbeatLoop(ctx)
	go func() {
		<-ctx.Done()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer shutdownCancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	logger.Info("nova agent starting", "node_id", cfg.nodeID, "listen", cfg.listen, "version", agentVersion)
	if err := server.ListenAndServeTLS(cfg.tlsCert, cfg.tlsKey); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("agent server stopped", "error", err)
		os.Exit(1)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func decodeSecret(encoded string) ([]byte, error) {
	decoded, err := decodeBase64(encoded)
	if err != nil || len(decoded) < 32 { return nil, fmt.Errorf("invalid key") }
	return decoded, nil
}

func requestDigest(body []byte) string { sum := sha256.Sum256(body); return hex.EncodeToString(sum[:]) }

func requestSignature(secret []byte, method, requestPath, timestamp, nonce string, body []byte) []byte {
	canonical := timestamp + "\n" + nonce + "\n" + strings.ToUpper(method) + "\n" + requestPath + "\n" + requestDigest(body)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(canonical))
	return mac.Sum(nil)
}

func (a *agent) authenticate(r *http.Request, body []byte) error {
	if r.URL.RawQuery != "" { return errors.New("query parameters are not accepted") }
	timestamp := r.Header.Get("X-Nova-Timestamp")
	nonce := r.Header.Get("X-Nova-Nonce")
	signature := r.Header.Get("X-Nova-Signature")
	if len(timestamp) != 10 || !safeNonce(nonce) || len(signature) != 64 { return errors.New("malformed signature headers") }
	seconds, err := parseUnix(timestamp)
	if err != nil || abs(time.Now().Unix()-seconds) > 30 { return errors.New("request expired") }
	provided, err := hex.DecodeString(signature)
	if err != nil { return errors.New("malformed signature") }
	expected := requestSignature(a.config.secret, r.Method, r.URL.Path, timestamp, nonce, body)
	if len(provided) != len(expected) || subtle.ConstantTimeCompare(provided, expected) != 1 { return errors.New("signature mismatch") }
	if !a.replays.Use(nonce, time.Now().Add(2*time.Minute)) { return errors.New("nonce already used") }
	return nil
}

func parseUnix(value string) (int64, error) {
	var result int64
	for _, c := range value { if c < '0' || c > '9' { return 0, errors.New("not unix seconds") }; result = result*10 + int64(c-'0') }
	if len(value) != 10 { return 0, errors.New("not unix seconds") }
	return result, nil
}

func abs(value int64) int64 { if value < 0 { return -value }; return value }
func safeNonce(value string) bool { if len(value) < 32 || len(value) > 64 { return false }; for _, c := range value { if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') { return false } }; return true }

func readBounded(r io.Reader, limit int64) ([]byte, error) { return io.ReadAll(io.LimitReader(r, limit+1)) }
