package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeRules is an MCP server with one search_rules tool, standing in for the rootrules server.
func fakeRules(t *testing.T, token string) *httptest.Server {
	t.Helper()
	server := mcp.NewServer(&mcp.Implementation{Name: "fake-rules", Version: "1"}, &mcp.ServerOptions{
		Instructions: "Use the tools. Do not answer from memory.",
	})
	type args struct {
		Query string `json:"query"`
	}
	mcp.AddTool(server, &mcp.Tool{Name: "search_rules", Description: "Search the rules"},
		func(ctx context.Context, req *mcp.CallToolRequest, a args) (*mcp.CallToolResult, any, error) {
			return &mcp.CallToolResult{Content: []mcp.Content{
				&mcp.TextContent{Text: "### §4.3.1 Step 1: Defender May Ambush\nThe defender may play one ambush card. (query: " + a.Query + ")"},
			}}, nil, nil
		})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true})
	mux := http.NewServeMux()
	mux.Handle("/mcp", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token != "" && r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {})
	mux.HandleFunc("/api/rules", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"rules": []any{map[string]string{"id": r.URL.Query().Get("ids")}}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// fakeLLM replays one scripted streaming response per request and records the requests.
type fakeLLM struct {
	mu       sync.Mutex
	replies  [][]string // per request: SSE data payloads
	requests []chatRequest
}

func (f *fakeLLM) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	json.NewDecoder(r.Body).Decode(&req)
	f.mu.Lock()
	n := len(f.requests)
	f.requests = append(f.requests, req)
	f.mu.Unlock()
	if n >= len(f.replies) {
		http.Error(w, `{"error":"no more scripted replies"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	for _, data := range f.replies[n] {
		fmt.Fprintf(w, "data: %s\n\n", data)
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
}

func toolCallChunks(id, name, args string) []string {
	half := len(args) / 2
	return []string{
		fmt.Sprintf(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":%q,"type":"function","function":{"name":%q,"arguments":%q}}]}}]}`, id, name, args[:half]),
		fmt.Sprintf(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":%q}}]}}]}`, args[half:]),
		`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
	}
}

func contentChunks(parts ...string) []string {
	var out []string
	for _, p := range parts {
		out = append(out, fmt.Sprintf(`{"choices":[{"delta":{"content":%q}}]}`, p))
	}
	return append(out, `{"choices":[{"delta":{},"finish_reason":"stop"}]}`)
}

type event struct {
	Name string
	Data map[string]any
}

func newTestServer(t *testing.T, llm *fakeLLM, maxSteps int) *httptest.Server {
	rules := fakeRules(t, "secret")
	lm := httptest.NewServer(llm)
	t.Cleanup(lm.Close)
	srv := &Server{Agent: &Agent{
		LLM:      &LLM{BaseURL: lm.URL, HTTP: http.DefaultClient},
		Rules:    &Rules{MCPURL: rules.URL + "/mcp", Token: "secret", HTTP: http.DefaultClient},
		MaxSteps: maxSteps,
	}, DefaultModel: "test-model"}
	app := httptest.NewServer(srv.Handler())
	t.Cleanup(app.Close)
	return app
}

func chat(t *testing.T, app *httptest.Server, question string) []event {
	t.Helper()
	body := fmt.Sprintf(`{"messages":[{"role":"user","content":%q}]}`, question)
	res, err := http.Post(app.URL+"/api/chat", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var events []event
	var name string
	scanner := bufio.NewScanner(res.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if v, ok := strings.CutPrefix(line, "event: "); ok {
			name = v
		} else if v, ok := strings.CutPrefix(line, "data: "); ok {
			var data map[string]any
			json.Unmarshal([]byte(v), &data)
			events = append(events, event{name, data})
		}
	}
	return events
}

func TestAgentResearchesThenAnswers(t *testing.T) {
	llm := &fakeLLM{replies: [][]string{
		toolCallChunks("call_1", "search_rules", `{"query":"ambush defender"}`),
		contentChunks("**Ruling:** Yes, ", "see §4.3.1."),
	}}
	app := newTestServer(t, llm, 8)
	events := chat(t, app, "Can I ambush?")

	var names []string
	var answer strings.Builder
	for _, e := range events {
		names = append(names, e.Name)
		if e.Name == evDelta {
			answer.WriteString(e.Data["text"].(string))
		}
	}
	want := "step tool_call tool_result step delta delta done"
	if got := strings.Join(names, " "); got != want {
		t.Fatalf("events = %q, want %q", got, want)
	}
	if answer.String() != "**Ruling:** Yes, see §4.3.1." {
		t.Errorf("answer = %q", answer.String())
	}
	if text := events[2].Data["text"].(string); !strings.Contains(text, "query: ambush defender") {
		t.Errorf("tool result = %q, want the fragmented arguments reassembled", text)
	}

	// First request: system prompt with the server's instructions, and the MCP tools.
	first := llm.requests[0]
	if first.Model != "test-model" || len(first.Tools) != 1 || first.Tools[0].Function.Name != "search_rules" {
		t.Errorf("first request model/tools = %q %+v", first.Model, first.Tools)
	}
	if !strings.Contains(first.Messages[0].Content, "Do not answer from memory") {
		t.Errorf("system prompt lacks server instructions: %q", first.Messages[0].Content)
	}
	// Second request carries the tool call and its result back to the model.
	second := llm.requests[1].Messages
	if n := len(second); second[n-2].Role != "assistant" || second[n-1].Role != "tool" || second[n-1].ToolCallID != "call_1" {
		t.Errorf("second request tail = %+v", second[n-2:])
	}
}

func TestAgentForcesAnswerAtStepLimit(t *testing.T) {
	llm := &fakeLLM{replies: [][]string{
		toolCallChunks("a", "search_rules", `{"query":"x"}`),
		contentChunks("Best effort answer."),
	}}
	app := newTestServer(t, llm, 2)
	events := chat(t, app, "Loop forever?")
	if last := events[len(events)-1]; last.Name != evDone {
		t.Fatalf("last event = %+v", last)
	}
	if tools := llm.requests[1].Tools; len(tools) != 0 {
		t.Errorf("final request still offered %d tools", len(tools))
	}
}

func eventNames(events []event) string {
	var names []string
	for _, e := range events {
		names = append(names, e.Name)
	}
	return strings.Join(names, " ")
}

func TestAgentRetractsAnswerWithoutResearch(t *testing.T) {
	llm := &fakeLLM{replies: [][]string{
		contentChunks("From memory: yes."),
		toolCallChunks("a", "search_rules", `{"query":"ambush"}`),
		contentChunks("**Ruling:** Yes, see §4.3.1."),
	}}
	events := chat(t, newTestServer(t, llm, 8), "Can I ambush?")
	want := "step delta retract step tool_call tool_result step delta done"
	if got := eventNames(events); got != want {
		t.Fatalf("events = %q, want %q", got, want)
	}
	// The withdrawn answer isn't sent back to the model; a system nudge is.
	second := llm.requests[1].Messages
	if last := second[len(second)-1]; last.Role != "system" || !strings.Contains(last.Content, "without consulting") {
		t.Errorf("second request tail = %+v", last)
	}
}

func TestAgentAcceptsSecondAnswerWithoutResearch(t *testing.T) {
	llm := &fakeLLM{replies: [][]string{
		contentChunks("I only arbitrate Root rules."),
		contentChunks("I only arbitrate Root rules."),
	}}
	events := chat(t, newTestServer(t, llm, 8), "What's the weather?")
	if got := eventNames(events); got != "step delta retract step delta done" {
		t.Fatalf("events = %q", got)
	}
}

func TestAgentWarnsAboutUnretrievedCitations(t *testing.T) {
	llm := &fakeLLM{replies: [][]string{
		toolCallChunks("a", "search_rules", `{"query":"ambush"}`),
		contentChunks("**Ruling:** Yes, per §4.3.1 and §7.7.7."),
	}}
	events := chat(t, newTestServer(t, llm, 8), "Can I ambush?")
	if got := eventNames(events); !strings.HasSuffix(got, "warning done") {
		t.Fatalf("events = %q", got)
	}
	warning := events[len(events)-2].Data
	if u := warning["unverified"].([]any); len(u) != 1 || u[0] != "§7.7.7" {
		t.Errorf("unverified = %v", u)
	}
}

func TestAgentReportsBadToolArguments(t *testing.T) {
	llm := &fakeLLM{replies: [][]string{
		toolCallChunks("a", "search_rules", `{"query": oops}`),
		contentChunks("Sorry."),
	}}
	app := newTestServer(t, llm, 8)
	events := chat(t, app, "?")
	for _, e := range events {
		if e.Name == evToolResult {
			if e.Data["isError"] != true || !strings.Contains(e.Data["text"].(string), "Invalid JSON") {
				t.Errorf("tool result = %+v", e.Data)
			}
			return
		}
	}
	t.Fatal("no tool_result event")
}

func TestChatSurfacesModelErrors(t *testing.T) {
	app := newTestServer(t, &fakeLLM{}, 8) // no scripted replies -> HTTP 500 with an error body
	events := chat(t, app, "?")
	last := events[len(events)-1]
	if last.Name != evError || !strings.Contains(last.Data["message"].(string), "no more scripted replies") {
		t.Fatalf("last event = %+v", last)
	}
}

func TestChatRejectsHistoryNotEndingWithUser(t *testing.T) {
	app := newTestServer(t, &fakeLLM{}, 8)
	res, err := http.Post(app.URL+"/api/chat", "application/json", strings.NewReader(`{"messages":[{"role":"assistant","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", res.StatusCode)
	}
}

func TestRuleProxyAndStaticFiles(t *testing.T) {
	app := newTestServer(t, &fakeLLM{}, 8)
	res, err := http.Get(app.URL + "/api/rule?ids=4.3.1")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(b), `"id":"4.3.1"`) {
		t.Errorf("proxy body = %s", b)
	}
	res, err = http.Get(app.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	b, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(b), "<title>Root Rules</title>") {
		t.Errorf("index not served")
	}
}
