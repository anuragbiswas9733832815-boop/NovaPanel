package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"syscall"
)

func decodeBase64(value string) ([]byte, error) { return base64.StdEncoding.DecodeString(value) }

type systemInfo struct {
	Architecture string `json:"architecture"`
	Virtualization string `json:"virtualization"`
	Services []string `json:"services"`
}

type telemetry struct {
	AgentVersion string  `json:"agentVersion"`
	CPUPercent float64 `json:"cpuPercent"`
	MemoryUsed string `json:"memoryUsed"`
	MemoryTotal string `json:"memoryTotal"`
	DiskUsed string `json:"diskUsed"`
	DiskTotal string `json:"diskTotal"`
	NetworkRxBytes string `json:"networkRxBytes"`
	NetworkTxBytes string `json:"networkTxBytes"`
	Hostname string `json:"hostname"`
	OperatingSystem string `json:"operatingSystem"`
	CPUCores int `json:"cpuCores"`
	IPAddresses []string `json:"ipAddresses"`
	SystemInfo systemInfo `json:"systemInfo"`
}

func (a *agent) heartbeatLoop(ctx context.Context) {
	client := &http.Client{Timeout: 8 * time.Second}
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	var previousTotal, previousIdle uint64
	for {
		total, idle, cpuErr := cpuCounters()
		cpu := 0.0
		if cpuErr == nil && previousTotal != 0 && total > previousTotal {
			allDelta, idleDelta := total-previousTotal, idle-previousIdle
			if allDelta > 0 { cpu = math.Round((1-float64(idleDelta)/float64(allDelta))*10000)/100 }
		}
		if cpuErr == nil { previousTotal, previousIdle = total, idle }
		state, err := collectTelemetry(cpu, a.config.siteRootPath)
		if err == nil {
			if sendErr := a.sendHeartbeat(ctx, client, state); sendErr != nil { a.logger.Warn("heartbeat delivery failed", "error", sendErr.Error()) }
		} else { a.logger.Warn("telemetry collection failed", "error", err.Error()) }
		select { case <-ctx.Done(): return; case <-ticker.C: }
	}
}

func (a *agent) sendHeartbeat(ctx context.Context, client *http.Client, state telemetry) error {
	body, err := json.Marshal(state)
	if err != nil { return err }
	path := "/api/agent/nodes/" + a.config.nodeID + "/heartbeat"
	endpoint := a.config.controlURL + path
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil { return err }
	nonce := hex.EncodeToString(nonceBytes)
	signature := requestSignature(a.config.secret, http.MethodPost, path, timestamp, nonce, body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil { return err }
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Nova-Timestamp", timestamp)
	req.Header.Set("X-Nova-Nonce", nonce)
	req.Header.Set("X-Nova-Signature", hex.EncodeToString(signature))
	resp, err := client.Do(req)
	if err != nil { return err }
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 { return fmt.Errorf("control plane returned HTTP %d", resp.StatusCode) }
	return nil
}

func collectTelemetry(cpu float64, siteRoot string) (telemetry, error) {
	memoryTotal, memoryAvailable, err := readMemory()
	if err != nil { return telemetry{}, err }
	stat := syscall.Statfs_t{}
	if err := syscall.Statfs(siteRoot, &stat); err != nil { return telemetry{}, err }
	diskTotal := stat.Blocks * uint64(stat.Bsize)
	diskFree := stat.Bavail * uint64(stat.Bsize)
	rx, tx, err := networkCounters()
	if err != nil { return telemetry{}, err }
	host, err := os.Hostname()
	if err != nil { return telemetry{}, err }
	ips := detectedIPs()
	inventory := systemInfo{Architecture: runtime.GOARCH, Virtualization: detectVirtualization(), Services: detectedServices()}
	return telemetry{AgentVersion:agentVersion, CPUPercent:cpu, MemoryUsed:strconv.FormatUint(memoryTotal-memoryAvailable, 10), MemoryTotal:strconv.FormatUint(memoryTotal, 10), DiskUsed:strconv.FormatUint(diskTotal-diskFree, 10), DiskTotal:strconv.FormatUint(diskTotal, 10), NetworkRxBytes:strconv.FormatUint(rx, 10), NetworkTxBytes:strconv.FormatUint(tx, 10), Hostname:host, OperatingSystem:detectedOS(), CPUCores:runtime.NumCPU(), IPAddresses:ips, SystemInfo:inventory}, nil
}

func detectedOS() string {
	data, err := os.ReadFile("/etc/os-release")
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") { return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\"'") }
		}
	}
	return runtime.GOOS
}

func detectedIPs() []string {
	interfaces, err := net.Interfaces()
	if err != nil { return []string{} }
	seen := map[string]bool{}
	result := []string{}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 { continue }
		addresses, err := iface.Addrs(); if err != nil { continue }
		for _, address := range addresses {
			var ip net.IP
			switch value := address.(type) { case *net.IPNet: ip = value.IP; case *net.IPAddr: ip = value.IP }
			if ip == nil || ip.IsLoopback() || ip.IsUnspecified() { continue }
			text := ip.String(); if !seen[text] { seen[text] = true; result = append(result, text) }
		}
	}
	sort.Strings(result)
	return result
}

func detectVirtualization() string {
	for _, path := range []string{"/sys/hypervisor/type", "/sys/class/dmi/id/product_name", "/sys/class/dmi/id/sys_vendor"} {
		data, err := os.ReadFile(path); if err != nil { continue }
		value := strings.TrimSpace(strings.ToLower(string(data)))
		if value == "" { continue }
		for _, marker := range []string{"kvm", "qemu", "vmware", "virtualbox", "xen", "hyper-v", "amazon ec2", "google", "openstack", "digitalocean"} {
			if strings.Contains(value, marker) { return marker }
		}
	}
	if data, err := os.ReadFile("/proc/1/cgroup"); err == nil && (strings.Contains(string(data), "docker") || strings.Contains(string(data), "containerd") || strings.Contains(string(data), "kubepods")) { return "container" }
	return "unknown"
}

func detectedServices() []string {
	candidates := []struct{ name, binary string }{{"nginx", "nginx"}, {"certbot", "certbot"}, {"php-fpm", "php-fpm"}, {"postgresql", "postgres"}, {"mariadb", "mariadbd"}, {"redis", "redis-server"}, {"nodejs", "node"}, {"docker", "docker"}, {"ftp", "vsftpd"}, {"mail", "dovecot"}}
	services := []string{}
	for _, service := range candidates { if _, err := exec.LookPath(service.binary); err == nil { services = append(services, service.name) } }
	return services
}

func cpuCounters() (uint64, uint64, error) {
	data, err := os.ReadFile("/proc/stat"); if err != nil { return 0, 0, err }
	line, _, _ := strings.Cut(string(data), "\n")
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" { return 0, 0, errors.New("invalid /proc/stat cpu line") }
	var total uint64
	values := make([]uint64, 0, len(fields)-1)
	for _, field := range fields[1:] { value, parseErr := strconv.ParseUint(field, 10, 64); if parseErr != nil { return 0, 0, parseErr }; values = append(values, value); total += value }
	idle := values[3]
	if len(values) > 4 { idle += values[4] }
	return total, idle, nil
}

func readMemory() (uint64, uint64, error) {
	file, err := os.Open("/proc/meminfo"); if err != nil { return 0, 0, err }; defer file.Close()
	var total, available uint64
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text()); if len(fields) < 2 { continue }
		value, parseErr := strconv.ParseUint(fields[1], 10, 64); if parseErr != nil { continue }; value *= 1024
		switch strings.TrimSuffix(fields[0], ":") { case "MemTotal": total = value; case "MemAvailable": available = value }
	}
	if err := scanner.Err(); err != nil { return 0, 0, err }
	if total == 0 || available > total { return 0, 0, errors.New("memory statistics unavailable") }
	return total, available, nil
}

func networkCounters() (uint64, uint64, error) {
	file, err := os.Open("/proc/net/dev"); if err != nil { return 0, 0, err }; defer file.Close()
	var rxTotal, txTotal uint64
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text(); if !strings.Contains(line, ":") { continue }
		name, data, _ := strings.Cut(line, ":"); if strings.TrimSpace(name) == "lo" { continue }
		fields := strings.Fields(data); if len(fields) < 9 { continue }
		rx, errRx := strconv.ParseUint(fields[0], 10, 64); tx, errTx := strconv.ParseUint(fields[8], 10, 64)
		if errRx == nil { rxTotal += rx }; if errTx == nil { txTotal += tx }
	}
	if err := scanner.Err(); err != nil { return 0, 0, err }
	return rxTotal, txTotal, nil
}
