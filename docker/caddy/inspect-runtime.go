// Native qualification mounts this diagnostic executable into the candidate.
package main

import (
	"encoding/json"
	"log"
	"os"
	"strings"
	"syscall"
)

func read(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	return strings.TrimSpace(string(data))
}

func main() {
	type metadata struct {
		UID, GID, Mode uint32
		Links          uint64
	}
	paths := map[string]metadata{}
	for _, path := range []string{"/usr/bin/caddy", "/data", "/data/caddy", "/config", "/config/caddy"} {
		var stat syscall.Stat_t
		if err := syscall.Lstat(path, &stat); err != nil {
			log.Fatal(err)
		}
		paths[path] = metadata{stat.Uid, stat.Gid, stat.Mode, uint64(stat.Nlink)}
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{
		"status": read("/proc/1/status"),
		"portStart": read("/proc/sys/net/ipv4/ip_unprivileged_port_start"),
		"paths": paths,
	}); err != nil {
		log.Fatal(err)
	}
}
