package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

//go:embed web
var webFiles embed.FS

const maxHistory = 20

type Server struct {
	Agent        *Agent
	DefaultModel string
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	web, _ := fs.Sub(webFiles, "web")
	mux.Handle("GET /", http.FileServerFS(web))
	mux.HandleFunc("GET /api/models", s.models)
	mux.HandleFunc("POST /api/chat", s.chat)
	mux.HandleFunc("GET /api/rule", func(w http.ResponseWriter, r *http.Request) {
		s.Agent.Rules.Proxy(w, r, "/api/rules", url.Values{"ids": {r.URL.Query().Get("ids")}})
	})
	mux.HandleFunc("GET /api/faq/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.Agent.Rules.Proxy(w, r, "/api/faq/"+url.PathEscape(r.PathValue("id")), nil)
	})
	return mux
}

func (s *Server) models(w http.ResponseWriter, r *http.Request) {
	ids, err := s.Agent.LLM.Models(r.Context())
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	def := s.DefaultModel
	if def == "" && len(ids) > 0 {
		def = ids[0]
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": ids, "default": def})
}

type chatRequestBody struct {
	Model    string `json:"model"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
}

// chat streams one answer as server-sent events.
func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	var body chatRequestBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request: " + err.Error()})
		return
	}
	// Only plain user/assistant text is accepted from the client; the model re-researches each turn.
	var history []Message
	for _, m := range body.Messages {
		if (m.Role == "user" || m.Role == "assistant") && strings.TrimSpace(m.Content) != "" {
			history = append(history, Message{Role: m.Role, Content: m.Content})
		}
	}
	if len(history) > maxHistory {
		history = history[len(history)-maxHistory:]
	}
	if len(history) == 0 || history[len(history)-1].Role != "user" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "the last message must be from the user"})
		return
	}
	model := body.Model
	if model == "" {
		model = s.DefaultModel
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)

	var mu sync.Mutex
	emit := func(event string, data any) {
		b, _ := json.Marshal(data)
		mu.Lock()
		defer mu.Unlock()
		w.Write([]byte("event: " + event + "\ndata: " + string(b) + "\n\n"))
		rc.Flush()
	}

	if err := s.Agent.Run(r.Context(), model, history, emit); err != nil {
		if errors.Is(err, context.Canceled) {
			return // client went away or pressed stop
		}
		log.Printf("chat: %v", err)
		emit(evError, map[string]string{"message": err.Error()})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
