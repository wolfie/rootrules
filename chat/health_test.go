package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func getHealth(t *testing.T, srv *Server) map[string]serviceHealth {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var got map[string]serviceHealth
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestHealth(t *testing.T) {
	rules := fakeRules(t, "secret")
	models := `{"data":[{"id":"some-model"},{"id":"text-embedding-x"}]}`
	lm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(models))
	}))
	t.Cleanup(lm.Close)
	srv := &Server{Agent: &Agent{
		LLM:   &LLM{BaseURL: lm.URL, HTTP: http.DefaultClient},
		Rules: &Rules{MCPURL: rules.URL + "/mcp", Token: "secret", HTTP: http.DefaultClient},
	}}

	if got := getHealth(t, srv); !got["llm"].OK || !got["rules"].OK {
		t.Fatalf("all up: got %+v", got)
	}

	models = `{"data":[{"id":"text-embedding-x"}]}`
	if got := getHealth(t, srv); got["llm"].OK || got["llm"].Error == "" {
		t.Fatalf("only embedding models: got %+v", got)
	}

	lm.Close()
	rules.Close()
	got := getHealth(t, srv)
	if got["llm"].OK || got["llm"].Error == "" || got["rules"].OK || got["rules"].Error == "" {
		t.Fatalf("all down: got %+v", got)
	}
}
