// rootrules-chat: a small chat UI for arbitrating Root rules with a local model (LM Studio)
// and the rootrules MCP server. Serves locally and/or as its own device on your tailnet.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

func main() {
	configDir, _ := os.UserConfigDir()
	var (
		lmURL      = flag.String("lmstudio", "http://localhost:1234/v1", "OpenAI-compatible API base URL")
		lmToken    = flag.String("lmstudio-token", "", "API token if LM Studio requires authentication")
		model      = flag.String("model", "", "default model id; empty = first listed")
		rulesURL   = flag.String("rules", "http://localhost:8787/mcp", "rootrules MCP endpoint")
		rulesToken = flag.String("rules-token", "", "bearer token for the rules server")
		listen     = flag.String("listen", "127.0.0.1:8090", "local listen address; empty to disable")
		tsHostname = flag.String("ts-hostname", "", "join the tailnet as this device name, e.g. rootrules")
		tsDir      = flag.String("ts-dir", filepath.Join(configDir, "rootrules-chat", "tsnet"), "tailscale state directory")
		tsHTTPS    = flag.Bool("ts-https", true, "serve HTTPS on the tailnet (needs MagicDNS + HTTPS certificates enabled)")
		maxSteps   = flag.Int("max-steps", 8, "maximum model calls per answer")
	)
	if err := parseConfig(flag.CommandLine, os.Args[1:]); err != nil {
		log.Fatal(err)
	}

	srv := &Server{
		Agent: &Agent{
			LLM:      &LLM{BaseURL: strings.TrimRight(*lmURL, "/"), Token: *lmToken, HTTP: &http.Client{}},
			Rules:    &Rules{MCPURL: *rulesURL, Token: *rulesToken, HTTP: &http.Client{Timeout: 30 * time.Second}},
			MaxSteps: *maxSteps,
		},
		DefaultModel: *model,
	}
	handler := logRequests(srv.Handler())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 3)
	var servers []*http.Server

	serve := func(ln net.Listener, h http.Handler) {
		s := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
		servers = append(servers, s)
		go func() { errc <- s.Serve(ln) }()
	}

	if *listen != "" {
		ln, err := net.Listen("tcp", *listen)
		if err != nil {
			log.Fatalf("listen %s: %v", *listen, err)
		}
		log.Printf("serving on http://%s", ln.Addr())
		serve(ln, handler)
	}

	if *tsHostname != "" {
		ts := &tsnet.Server{
			Hostname: *tsHostname,
			Dir:      *tsDir,
			// First run without TS_AUTHKEY prints a login URL here.
			UserLogf: log.Printf,
			Logf:     func(string, ...any) {},
		}
		defer ts.Close()
		status, err := ts.Up(ctx)
		if err != nil {
			log.Fatalf("tailscale: %v", err)
		}
		name := strings.TrimSuffix(status.Self.DNSName, ".")
		if *tsHTTPS {
			ln, err := ts.ListenTLS("tcp", ":443")
			if err != nil {
				log.Fatalf("tailscale https: %v", err)
			}
			serve(ln, handler)
			plain, err := ts.Listen("tcp", ":80")
			if err != nil {
				log.Fatalf("tailscale http: %v", err)
			}
			serve(plain, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "https://"+name+r.URL.RequestURI(), http.StatusMovedPermanently)
			}))
			log.Printf("serving on https://%s", name)
		} else {
			ln, err := ts.Listen("tcp", ":80")
			if err != nil {
				log.Fatalf("tailscale http: %v", err)
			}
			serve(ln, handler)
			log.Printf("serving on http://%s", name)
		}
	}

	if len(servers) == 0 {
		log.Fatal("nothing to serve: set -listen and/or -ts-hostname")
	}

	select {
	case <-ctx.Done():
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server: %v", err)
		}
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, s := range servers {
		s.Shutdown(shutdown)
	}
}

func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			log.Printf("%s %s", r.Method, r.URL.Path)
		}
		h.ServeHTTP(w, r)
	})
}
