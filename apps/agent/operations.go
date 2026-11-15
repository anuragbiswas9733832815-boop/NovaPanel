package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html"
	"io/fs"
	"net/http"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var validDomain = regexp.MustCompile(`^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)

type operationRequest struct {
	Operation string `json:"operation"`
	SiteID string `json:"siteId"`
	Domain string `json:"domain"`
	RequestID string `json:"requestId"`
	Path string `json:"path,omitempty"`
	NewPath string `json:"newPath,omitempty"`
	ContentBase64 string `json:"contentBase64,omitempty"`
}

type siteManifest struct { SiteID string `json:"siteId"`; Domain string `json:"domain"`; CreatedAt time.Time `json:"createdAt"` }

type directoryEntry struct { Name string `json:"name"`; Type string `json:"type"`; Size int64 `json:"size"`; ModifiedAt time.Time `json:"modifiedAt"` }

type operationResponse struct { OK bool `json:"ok"`; Operation string `json:"operation"`; Entries []directoryEntry `json:"entries,omitempty"`; ContentBase64 string `json:"contentBase64,omitempty"`; Size int64 `json:"size,omitempty"` }

var operationMutex sync.Mutex

func (a *agent) handleOperation(w http.ResponseWriter, r *http.Request) {
	body, err := readBounded(r.Body, 12<<20)
	if err != nil || len(body) > 12<<20 { writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error":"request body too large"}); return }
	if err := a.authenticate(r, body); err != nil { a.logger.Warn("operation authentication rejected", "reason", err.Error()); writeJSON(w, http.StatusUnauthorized, map[string]string{"error":"authentication failed"}); return }
	var input operationRequest
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil { writeJSON(w, http.StatusBadRequest, map[string]string{"error":"invalid operation payload"}); return }
	if !safeID.MatchString(input.SiteID) || !safeID.MatchString(input.RequestID) { writeJSON(w, http.StatusBadRequest, map[string]string{"error":"invalid operation identifier"}); return }
	operationMutex.Lock()
	defer operationMutex.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 150*time.Second)
	defer cancel()
	result, err := a.execute(ctx, input)
	a.logger.Info("operation audited", "request_id", input.RequestID, "site_id", input.SiteID, "operation", input.Operation, "success", err == nil)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, fs.ErrNotExist) { status = http.StatusNotFound }
		if errors.Is(err, errConflict) { status = http.StatusConflict }
		if errors.Is(err, errService) { status = http.StatusServiceUnavailable }
		writeJSON(w, status, map[string]string{"error":publicError(err)})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

var errConflict = errors.New("conflict")
var errService = errors.New("service unavailable")

func publicError(err error) string {
	switch {
	case errors.Is(err, errConflict): return "resource conflicts with existing node state"
	case errors.Is(err, errService): return "web server configuration could not be applied"
	case errors.Is(err, fs.ErrNotExist): return "site or file was not found"
	default: return "operation could not be completed"
	}
}

func (a *agent) execute(ctx context.Context, in operationRequest) (operationResponse, error) {
	switch in.Operation {
	case "website.create": return a.createWebsite(ctx, in)
	case "website.delete": return a.deleteWebsite(ctx, in)
	case "website.ssl.enable": return a.enableTLS(ctx, in)
	case "files.list": return a.listFiles(in)
	case "files.read": return a.readFile(in)
	case "files.write": return a.writeFile(in)
	case "files.mkdir": return a.makeDirectory(in)
	case "files.delete": return a.removeFile(in)
	case "files.rename": return a.renameFile(in)
	default: return operationResponse{}, errors.New("operation not allowlisted")
	}
}

func (a *agent) siteRoot(siteID string) (*os.Root, error) {
	if !safeID.MatchString(siteID) { return nil, errors.New("invalid site ID") }
	return a.sitesRoot.OpenRoot(filepath.ToSlash(filepath.Join("sites", siteID, "public_html")))
}

func (a *agent) siteBase(siteID string) string { return filepath.Join("sites", siteID) }
func (a *agent) nginxPaths(siteID string) (string, string) {
	name := "nova-" + siteID + ".conf"
	return filepath.Join(a.config.nginxAvailable, name), filepath.Join(a.config.nginxEnabled, name)
}

func manifestAt(root *os.Root, siteID string) (siteManifest, error) {
	file, err := root.Open(filepath.ToSlash(filepath.Join("sites", siteID, ".nova-site.json")))
	if err != nil { return siteManifest{}, err }
	defer file.Close()
	var manifest siteManifest
	if err := json.NewDecoder(io.LimitReader(file, 4096)).Decode(&manifest); err != nil { return siteManifest{}, err }
	return manifest, nil
}

func (a *agent) createWebsite(ctx context.Context, in operationRequest) (operationResponse, error) {
	domain := strings.ToLower(in.Domain)
	if !validDomain.MatchString(domain) { return operationResponse{}, errors.New("invalid domain") }
	base := a.siteBase(in.SiteID)
	base := a.siteBase(in.SiteID)
	manifestPath := filepath.ToSlash(filepath.Join(base, ".nova-site.json"))
	manifest := siteManifest{SiteID: in.SiteID, Domain: domain, CreatedAt: time.Now().UTC()}
	createdTree, completed := false, false
	defer func() { if createdTree && !completed { _ = a.sitesRoot.RemoveAll(base) } }()
	if existing, readErr := manifestAt(a.sitesRoot, in.SiteID); readErr == nil {
		if existing.SiteID != in.SiteID || existing.Domain != domain { return operationResponse{}, errConflict }
	} else if !errors.Is(readErr, fs.ErrNotExist) { return operationResponse{}, readErr } else {
		if _, statErr := a.sitesRoot.Lstat(base); statErr == nil { return operationResponse{}, errConflict } else if !errors.Is(statErr, fs.ErrNotExist) { return operationResponse{}, statErr }
		if err := a.sitesRoot.MkdirAll(base, 0700); err != nil { return operationResponse{}, err }
		createdTree = true
		manifestBytes, _ := json.Marshal(manifest)
		if err := writeOwnedFile(a.sitesRoot, manifestPath, manifestBytes, 0644); err != nil { _ = a.sitesRoot.RemoveAll(base); return operationResponse{}, err }
	}
	publicRoot := filepath.ToSlash(filepath.Join(base, "public_html"))
	if err := a.sitesRoot.MkdirAll(publicRoot, 0755); err != nil { return operationResponse{}, err }
	for _, dir := range []string{"sites", base, publicRoot} { if err := a.sitesRoot.Chmod(dir, 0755); err != nil { return operationResponse{}, err } }
	welcome := []byte("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + html.EscapeString(domain) + "</title><body><main><h1>" + html.EscapeString(domain) + "</h1><p>Your Nova Hosting website is ready. Upload your site files to replace this page.</p></main></body></html>")
	indexPath := filepath.ToSlash(filepath.Join(publicRoot, "index.html"))
	if info, statErr := a.sitesRoot.Lstat(indexPath); errors.Is(statErr, fs.ErrNotExist) {
		if err := writeOwnedFile(a.sitesRoot, indexPath, welcome, 0644); err != nil { return operationResponse{}, err }
	} else if statErr != nil { return operationResponse{}, statErr
	} else if !info.Mode().IsRegular() { return operationResponse{}, errConflict }
	available, enabled := a.nginxPaths(in.SiteID)
	configText := a.nginxConfig(in.SiteID, domain, false)
	if err := os.MkdirAll(a.config.nginxAvailable, 0755); err != nil { return operationResponse{}, err }
	if err := os.MkdirAll(a.config.nginxEnabled, 0755); err != nil { return operationResponse{}, err }
	createdConfig, err := createOrVerifyConfig(available, configText)
	if err != nil { if createdConfig { _ = os.Remove(available) }; return operationResponse{}, err }
	createdLink, err := createOrVerifyLink(enabled, available)
	if err != nil { if createdConfig { _ = os.Remove(available) }; return operationResponse{}, err }
	if err := a.applyNginx(ctx); err != nil {
		if createdLink { _ = os.Remove(enabled) }
		if createdConfig { _ = os.Remove(available) }
		return operationResponse{}, err
	}
	completed = true
	return operationResponse{OK:true, Operation:in.Operation}, nil
}

func (a *agent) deleteWebsite(ctx context.Context, in operationRequest) (operationResponse, error) {
	if !validDomain.MatchString(strings.ToLower(in.Domain)) { return operationResponse{}, errors.New("invalid domain") }
	manifest, err := manifestAt(a.sitesRoot, in.SiteID)
	if err != nil && !errors.Is(err, fs.ErrNotExist) { return operationResponse{}, err }
	if err == nil && (manifest.SiteID != in.SiteID || manifest.Domain != strings.ToLower(in.Domain)) { return operationResponse{}, errConflict }
	available, enabled := a.nginxPaths(in.SiteID)
	if _, statErr := os.Lstat(available); statErr == nil {
		data, readErr := os.ReadFile(available)
		if readErr != nil || !strings.Contains(string(data), "# nova-site-id="+in.SiteID+"\n") { return operationResponse{}, errConflict }
		hadLink := false
		if target, linkErr := os.Readlink(enabled); linkErr == nil {
			if target != available { return operationResponse{}, errConflict }
			hadLink = true
			if err := os.Remove(enabled); err != nil { return operationResponse{}, err }
		} else if !errors.Is(linkErr, fs.ErrNotExist) { return operationResponse{}, errConflict }
		if err := os.Remove(available); err != nil { return operationResponse{}, err }
		if err := a.applyNginx(ctx); err != nil {
			if _, restoreErr := createOrVerifyConfig(available, string(data)); restoreErr != nil { a.logger.Error("failed to restore site config after delete rollback", "site_id", in.SiteID, "error", restoreErr) }
			if hadLink { if _, restoreErr := createOrVerifyLink(enabled, available); restoreErr != nil { a.logger.Error("failed to restore enabled site link", "site_id", in.SiteID, "error", restoreErr) } }
			return operationResponse{}, err
		}
	} else if !errors.Is(statErr, fs.ErrNotExist) { return operationResponse{}, statErr
	} else if _, linkErr := os.Lstat(enabled); linkErr == nil { return operationResponse{}, errConflict
	} else if !errors.Is(linkErr, fs.ErrNotExist) { return operationResponse{}, linkErr }
	for _, certName := range []string{"nova-" + in.SiteID, "nova-" + in.SiteID + "-staging"} {
		if _, certErr := os.Lstat(filepath.Join("/etc/letsencrypt", "live", certName)); certErr == nil {
			cleanupCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			output, cleanupErr := exec.CommandContext(cleanupCtx, "/usr/bin/certbot", "delete", "--cert-name", certName, "--non-interactive", "--config-dir", "/etc/letsencrypt", "--work-dir", "/var/lib/letsencrypt", "--logs-dir", "/var/log/letsencrypt").CombinedOutput()
			cancel()
			if cleanupErr != nil { a.logger.Error("certificate cleanup failed after website deletion", "site_id", in.SiteID, "output", limitText(string(output), 300)) }
		} else if !errors.Is(certErr, fs.ErrNotExist) { a.logger.Error("could not inspect certificate during website deletion", "site_id", in.SiteID, "error", certErr) }
	}
	if err := a.sitesRoot.RemoveAll(a.siteBase(in.SiteID)); err != nil && !errors.Is(err, fs.ErrNotExist) { return operationResponse{}, err }
	return operationResponse{OK:true, Operation:in.Operation}, nil
}

func (a *agent) enableTLS(ctx context.Context, in operationRequest) (operationResponse, error) {
	domain := strings.ToLower(in.Domain)
	if !validDomain.MatchString(domain) { return operationResponse{}, errors.New("invalid domain") }
	manifest, err := manifestAt(a.sitesRoot, in.SiteID)
	if err != nil { return operationResponse{}, err }
	if manifest.SiteID != in.SiteID || manifest.Domain != domain { return operationResponse{}, errConflict }
	available, _ := a.nginxPaths(in.SiteID)
	info, err := os.Lstat(available)
	if err != nil { return operationResponse{}, err }
	if !info.Mode().IsRegular() { return operationResponse{}, errConflict }
	oldConfig, err := os.ReadFile(available)
	if err != nil { return operationResponse{}, err }
	httpConfig := a.nginxConfig(in.SiteID, domain, false)
	tlsConfig := a.nginxConfig(in.SiteID, domain, true)
	alternateCertName := "nova-" + in.SiteID
	if !a.config.acmeStaging { alternateCertName += "-staging" }
	alternateTLSConfig := a.nginxConfigWithCert(in.SiteID, domain, true, alternateCertName)
	if string(oldConfig) != httpConfig && string(oldConfig) != tlsConfig && string(oldConfig) != alternateTLSConfig { return operationResponse{}, errConflict }
	certName := a.certificateName(in.SiteID)
	webRoot := filepath.Join(a.config.siteRootPath, "sites", in.SiteID, "public_html")
	args := []string{"certonly", "--config-dir", "/etc/letsencrypt", "--work-dir", "/var/lib/letsencrypt", "--logs-dir", "/var/log/letsencrypt", "--webroot", "--webroot-path", webRoot, "--domain", domain, "--cert-name", certName, "--non-interactive", "--agree-tos", "--email", a.config.acmeEmail, "--no-eff-email", "--keep-until-expiring"}
	if a.config.acmeStaging { args = append(args, "--test-cert") }
	certbotCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	output, err := exec.CommandContext(certbotCtx, "/usr/bin/certbot", args...).CombinedOutput()
	if err != nil {
		a.logger.Error("ACME certificate issuance failed", "site_id", in.SiteID, "output", limitText(string(output), 500))
		return operationResponse{}, errService
	}
	certDir := filepath.Join("/etc/letsencrypt", "live", certName)
	for _, certFile := range []string{"fullchain.pem", "privkey.pem"} {
		certInfo, statErr := os.Stat(filepath.Join(certDir, certFile))
		if statErr != nil || !certInfo.Mode().IsRegular() { return operationResponse{}, errService }
	}
	if string(oldConfig) != tlsConfig {
		if err := replaceOwnedConfig(available, in.SiteID, string(oldConfig), tlsConfig); err != nil { return operationResponse{}, err }
		if err := a.applyNginx(ctx); err != nil {
			if restoreErr := replaceOwnedConfig(available, in.SiteID, tlsConfig, string(oldConfig)); restoreErr != nil { a.logger.Error("failed to restore HTTP site config after TLS rollback", "site_id", in.SiteID, "error", restoreErr) } else if reloadErr := a.applyNginx(ctx); reloadErr != nil { a.logger.Error("failed to reload restored HTTP site config", "site_id", in.SiteID, "error", reloadErr) }
			return operationResponse{}, err
		}
	}
	return operationResponse{OK:true, Operation:in.Operation}, nil
}

func replaceOwnedConfig(filename, siteID, expected, replacement string) error {
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() { return errConflict }
	old, err := os.ReadFile(filename)
	if err != nil { return err }
	if string(old) != expected || !strings.HasPrefix(string(old), "# nova-site-id="+siteID+"\n") { return errConflict }
	token := make([]byte, 12)
	if _, err := rand.Read(token); err != nil { return err }
	temporary := filename + ".nova-tmp-" + hex.EncodeToString(token)
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil { return err }
	if _, err := file.WriteString(replacement); err != nil { _ = file.Close(); _ = os.Remove(temporary); return err }
	if err := file.Chmod(0644); err != nil { _ = file.Close(); _ = os.Remove(temporary); return err }
	if err := file.Sync(); err != nil { _ = file.Close(); _ = os.Remove(temporary); return err }
	if err := file.Close(); err != nil { _ = os.Remove(temporary); return err }
	if err := os.Rename(temporary, filename); err != nil { _ = os.Remove(temporary); return err }
	return nil
}

func (a *agent) certificateName(siteID string) string {
	name := "nova-" + siteID
	if a.config.acmeStaging { return name + "-staging" }
	return name
}

func (a *agent) nginxConfig(siteID, domain string, tlsEnabled bool) string {
	return a.nginxConfigWithCert(siteID, domain, tlsEnabled, a.certificateName(siteID))
}

func (a *agent) nginxConfigWithCert(siteID, domain string, tlsEnabled bool, certName string) string {
	root := filepath.Join(a.config.siteRootPath, "sites", siteID, "public_html")
	accessLog := "/var/log/nginx/nova-" + siteID + ".access.log"
	errorLog := "/var/log/nginx/nova-" + siteID + ".error.log"
	common := "    server_name " + domain + ";\n    root " + root + ";\n    index index.html;\n    autoindex off;\n    access_log " + accessLog + ";\n    error_log " + errorLog + ";\n    server_tokens off;\n    location ~* \\.(?:php[0-9]?|phtml|phar)(?:$|/) { return 404; }\n    location ~ /\\.(?!well-known) { deny all; }\n"
	if !tlsEnabled {
		return "# nova-site-id=" + siteID + "\nserver {\n    listen 80;\n" + common + "    location / { try_files $uri $uri/ =404; }\n}\n"
	}
	return "# nova-site-id=" + siteID + "\nserver {\n    listen 80;\n" + common + "    location ^~ /.well-known/acme-challenge/ { default_type text/plain; try_files $uri =404; }\n    location / { return 301 https://$host$request_uri; }\n}\nserver {\n    listen 443 ssl http2;\n" + common + "    ssl_certificate /etc/letsencrypt/live/" + certName + "/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/" + certName + "/privkey.pem;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_session_cache shared:nova_" + siteID + ":10m;\n    ssl_session_timeout 1d;\n    add_header Strict-Transport-Security \"max-age=31536000\" always;\n    add_header X-Content-Type-Options nosniff always;\n    location / { try_files $uri $uri/ =404; }\n}\n"
}

func writeOwnedFile(root *os.Root, name string, content []byte, mode fs.FileMode) error {
	if info, err := root.Lstat(name); err == nil {
		if !info.Mode().IsRegular() { return errConflict }
		existing, readErr := root.Open(name)
		if readErr != nil { return readErr }
		defer existing.Close()
		old, readErr := readBounded(existing, int64(len(content))+1)
		if readErr != nil { return readErr }
		if string(old) == string(content) { return nil }
		return errConflict
	} else if !errors.Is(err, fs.ErrNotExist) { return err }
	token := make([]byte, 12)
	if _, err := rand.Read(token); err != nil { return err }
	temporary := name + ".nova-tmp-" + hex.EncodeToString(token)
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil { return err }
	if _, err := file.Write(content); err != nil { _ = file.Close(); _ = root.Remove(temporary); return err }
	if err := file.Chmod(mode); err != nil { _ = file.Close(); _ = root.Remove(temporary); return err }
	if err := file.Close(); err != nil { _ = root.Remove(temporary); return err }
	if err := root.Link(temporary, name); err != nil { _ = root.Remove(temporary); if errors.Is(err, fs.ErrExist) { return writeOwnedFile(root, name, content, mode) }; return err }
	return root.Remove(temporary)
}

func createOrVerifyConfig(filename, content string) (bool, error) {
	if info, err := os.Lstat(filename); err == nil {
		if !info.Mode().IsRegular() { return false, errConflict }
		old, readErr := os.ReadFile(filename)
		if readErr != nil { return false, readErr }
		if string(old) == content { return false, nil }
		return false, errConflict
	} else if !errors.Is(err, fs.ErrNotExist) { return false, err }
	token := make([]byte, 12)
	if _, err := rand.Read(token); err != nil { return false, err }
	temporary := filename + ".nova-tmp-" + hex.EncodeToString(token)
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil { return false, err }
	if _, err := file.WriteString(content); err != nil { _ = file.Close(); _ = os.Remove(temporary); return false, err }
	if err := file.Chmod(0644); err != nil { _ = file.Close(); _ = os.Remove(temporary); return false, err }
	if err := file.Close(); err != nil { _ = os.Remove(temporary); return false, err }
	if err := os.Link(temporary, filename); err != nil {
		_ = os.Remove(temporary)
		if errors.Is(err, fs.ErrExist) { return createOrVerifyConfig(filename, content) }
		return false, err
	}
	if err := os.Remove(temporary); err != nil { return true, err }
	return true, nil
}

func createOrVerifyLink(link, target string) (bool, error) {
	if current, err := os.Readlink(link); err == nil {
		if current == target { return false, nil }
		return false, errConflict
	} else if !errors.Is(err, fs.ErrNotExist) { return false, err }
	if err := os.Symlink(target, link); err != nil {
		if errors.Is(err, fs.ErrExist) { return createOrVerifyLink(link, target) }
		return false, err
	}
	return true, nil
}

func (a *agent) applyNginx(ctx context.Context) error {
	validateCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	output, err := exec.CommandContext(validateCtx, "/usr/sbin/nginx", "-t").CombinedOutput()
	if err != nil { a.logger.Error("nginx configuration validation failed", "output", limitText(string(output), 500)); return errService }
	reloadCtx, cancelReload := context.WithTimeout(ctx, 8*time.Second)
	defer cancelReload()
	output, err = exec.CommandContext(reloadCtx, "/bin/systemctl", "reload", "nginx").CombinedOutput()
	if err != nil { a.logger.Error("nginx reload failed", "output", limitText(string(output), 500)); return errService }
	return nil
}

func limitText(value string, max int) string { if len(value) <= max { return value }; return value[:max] }

func safeRelative(value string, allowRoot bool) (string, error) {
	if strings.ContainsRune(value, '\\') || strings.ContainsRune(value, 0) || strings.HasPrefix(value, "/") { return "", errors.New("invalid file path") }
	clean := path.Clean(value)
	if clean == "." && allowRoot { return clean, nil }
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") { return "", errors.New("invalid file path") }
	return clean, nil
}

func (a *agent) listFiles(in operationRequest) (operationResponse, error) {
	site, err := a.siteRoot(in.SiteID); if err != nil { return operationResponse{}, err }; defer site.Close()
	name, err := safeRelative(in.Path, true); if err != nil { return operationResponse{}, err }
	dir, err := site.Open(name); if err != nil { return operationResponse{}, err }; defer dir.Close()
	entries, err := dir.ReadDir(1001); if err != nil { return operationResponse{}, err }
	if len(entries) > 1000 { return operationResponse{}, errors.New("directory has too many entries; use narrower folders") }
	result := make([]directoryEntry, 0, len(entries))
	for _, entry := range entries {
		info, statErr := entry.Info(); if statErr != nil { return operationResponse{}, statErr }
		typeName := "file"; if info.IsDir() { typeName = "directory" } else if info.Mode()&fs.ModeSymlink != 0 { typeName = "symlink" }
		result = append(result, directoryEntry{Name:entry.Name(), Type:typeName, Size:info.Size(), ModifiedAt:info.ModTime().UTC()})
	}
	return operationResponse{OK:true, Operation:in.Operation, Entries:result}, nil
}

func (a *agent) readFile(in operationRequest) (operationResponse, error) {
	site, err := a.siteRoot(in.SiteID); if err != nil { return operationResponse{}, err }; defer site.Close()
	name, err := safeRelative(in.Path, false); if err != nil { return operationResponse{}, err }
	file, err := site.Open(name); if err != nil { return operationResponse{}, err }; defer file.Close()
	data, err := readBounded(file, 2<<20); if err != nil { return operationResponse{}, err }; if len(data) > 2<<20 { return operationResponse{}, errors.New("file exceeds the 2 MiB API read limit") }
	return operationResponse{OK:true, Operation:in.Operation, ContentBase64:base64.StdEncoding.EncodeToString(data), Size:int64(len(data))}, nil
}

func parentAndBase(name string) (string, string) { parent := path.Dir(name); if parent == "." { parent = "." }; return parent, path.Base(name) }

func ensureSiteDirectories(root *os.Root, name string) error {
	clean, err := safeRelative(name, true)
	if err != nil { return err }
	if clean == "." { return nil }
	current := ""
	for _, component := range strings.Split(clean, "/") {
		if current == "" { current = component } else { current += "/" + component }
		if err := root.MkdirAll(current, 0755); err != nil { return err }
		if err := root.Chmod(current, 0755); err != nil { return err }
	}
	return nil
}

func (a *agent) writeFile(in operationRequest) (operationResponse, error) {
	name, err := safeRelative(in.Path, false); if err != nil { return operationResponse{}, err }
	data, err := base64.StdEncoding.DecodeString(in.ContentBase64); if err != nil || len(data) > 8<<20 { return operationResponse{}, errors.New("file content is invalid or exceeds 8 MiB") }
	site, err := a.siteRoot(in.SiteID); if err != nil { return operationResponse{}, err }; defer site.Close()
	parent, _ := parentAndBase(name); if err := ensureSiteDirectories(site, parent); err != nil { return operationResponse{}, err }
	if info, err := site.Lstat(name); err == nil && info.Mode()&fs.ModeSymlink != 0 { return operationResponse{}, errConflict }
	tmpToken := make([]byte, 12)
	if _, err := rand.Read(tmpToken); err != nil { return operationResponse{}, err }
	tmp := name + ".nova-upload-" + hex.EncodeToString(tmpToken)
	file, err := site.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644); if err != nil { return operationResponse{}, err }
	if _, err := file.Write(data); err != nil { _ = file.Close(); _ = site.Remove(tmp); return operationResponse{}, err }
	if err := file.Close(); err != nil { _ = site.Remove(tmp); return operationResponse{}, err }
	if err := site.Chmod(tmp, 0644); err != nil { _ = site.Remove(tmp); return operationResponse{}, err }
	if err := site.Rename(tmp, name); err != nil { _ = site.Remove(tmp); return operationResponse{}, err }
	return operationResponse{OK:true, Operation:in.Operation, Size:int64(len(data))}, nil
}

func (a *agent) makeDirectory(in operationRequest) (operationResponse, error) {
	name, err := safeRelative(in.Path, false); if err != nil { return operationResponse{}, err }
	site, err := a.siteRoot(in.SiteID); if err != nil { return operationResponse{}, err }; defer site.Close()
	if err := ensureSiteDirectories(site, name); err != nil { return operationResponse{}, err }
	return operationResponse{OK:true, Operation:in.Operation}, nil
}

func (a *agent) removeFile(in operationRequest) (operationResponse, error) {
	name, err := safeRelative(in.Path, false); if err != nil { return operationResponse{}, err }
	site, err := a.siteRoot(in.SiteID); if err != nil { return operationResponse{}, err }; defer site.Close()
	if err := site.RemoveAll(name); err != nil { return operationResponse{}, err }
	return operationResponse{OK:true, Operation:in.Operation}, nil
}

func (a *agent) renameFile(in operationRequest) (operationResponse, error) {
	oldName, err := safeRelative(in.Path, false); if err != nil { return operationResponse{}, err }
	newName, err := safeRelative(in.NewPath, false); if err != nil { return operationResponse{}, err }
	site, err := a.siteRoot(in.SiteID); if err != nil { return operationResponse{}, err }; defer site.Close()
	parent, _ := parentAndBase(newName); if err := ensureSiteDirectories(site, parent); err != nil { return operationResponse{}, err }
	if err := site.Rename(oldName, newName); err != nil { return operationResponse{}, err }
	return operationResponse{OK:true, Operation:in.Operation}, nil
}

func (a *agent) debugPath(siteID, relative string) string { return filepath.Join(a.config.siteRootPath, "sites", siteID, "public_html", relative) }
