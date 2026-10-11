package main

// Access to the rootrules server: its MCP tools for the model, and its REST API for the
// citation popovers in the UI.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const maxToolResultChars = 20_000

type Rules struct {
	MCPURL string // e.g. http://localhost:8787/mcp
	Token  string // optional bearer token
	HTTP   *http.Client
}

// bearerTransport adds the rules server token to every request.
type bearerTransport struct {
	token string
	base  http.RoundTripper
}

func (t bearerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+t.token)
	return t.base.RoundTrip(req)
}

func (r *Rules) client() *http.Client {
	if r.Token == "" {
		return r.HTTP
	}
	base := r.HTTP.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	return &http.Client{Transport: bearerTransport{r.Token, base}, Timeout: r.HTTP.Timeout}
}

// ToolSession is one MCP connection for the duration of a chat turn.
type ToolSession struct {
	session      *mcp.ClientSession
	Tools        []ToolDef
	Instructions string
}

func (r *Rules) Open(ctx context.Context) (*ToolSession, error) {
	client := mcp.NewClient(&mcp.Implementation{Name: "rootrules-chat", Version: "0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   r.MCPURL,
		HTTPClient: r.client(),
		// The rules server is stateless; it has no server-initiated messages to stream.
		DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("cannot reach the rules server at %s: %w", r.MCPURL, err)
	}
	list, err := session.ListTools(ctx, nil)
	if err != nil {
		session.Close()
		return nil, fmt.Errorf("listing rules tools: %w", err)
	}

	ts := &ToolSession{session: session}
	if init := session.InitializeResult(); init != nil {
		ts.Instructions = init.Instructions
	}
	for _, t := range list.Tools {
		params, _ := t.InputSchema.(map[string]any)
		if params == nil {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		delete(params, "$schema") // some OpenAI-compatible servers reject it
		ts.Tools = append(ts.Tools, ToolDef{
			Type:     "function",
			Function: FunctionDef{Name: t.Name, Description: t.Description, Parameters: params},
		})
	}
	return ts, nil
}

func (ts *ToolSession) Close() { ts.session.Close() }

// Call runs a tool with the model's JSON arguments. Failures are returned as text for the
// model to read, so it can correct itself, with isError set.
func (ts *ToolSession) Call(ctx context.Context, name, arguments string) (text string, isError bool) {
	args := map[string]any{}
	if strings.TrimSpace(arguments) != "" {
		if err := json.Unmarshal([]byte(arguments), &args); err != nil {
			return fmt.Sprintf("Invalid JSON arguments for %s: %v", name, err), true
		}
	}
	res, err := ts.session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return fmt.Sprintf("Tool %s failed: %v", name, err), true
	}
	var b strings.Builder
	for _, c := range res.Content {
		if t, ok := c.(*mcp.TextContent); ok {
			b.WriteString(t.Text)
		}
	}
	text = b.String()
	if len(text) > maxToolResultChars {
		text = text[:maxToolResultChars] + "\n\n[truncated — request fewer or smaller rules]"
	}
	return text, res.IsError
}

// RESTBase is the rules server root, derived from the MCP endpoint.
func (r *Rules) RESTBase() string {
	return strings.TrimSuffix(strings.TrimRight(r.MCPURL, "/"), "/mcp")
}

// Proxy forwards a GET to the rules server's REST API (e.g. "/api/rules?ids=4.3.1").
func (r *Rules) Proxy(w http.ResponseWriter, req *http.Request, path string, query url.Values) {
	target := r.RESTBase() + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	upstream, err := http.NewRequestWithContext(req.Context(), http.MethodGet, target, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	res, err := r.client().Do(upstream)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "rules server unreachable: " + err.Error()})
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", res.Header.Get("Content-Type"))
	w.WriteHeader(res.StatusCode)
	io.Copy(w, res.Body)
}
