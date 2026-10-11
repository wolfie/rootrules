package main

// Minimal streaming client for an OpenAI-compatible chat completions API (LM Studio).

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ToolDef struct {
	Type     string      `json:"type"`
	Function FunctionDef `json:"function"`
}

type FunctionDef struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Parameters  any    `json:"parameters"`
}

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	Tools    []ToolDef `json:"tools,omitempty"`
	Stream   bool      `json:"stream"`
}

type streamChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
			// LM Studio reports reasoning separately, depending on version and settings.
			ReasoningContent string `json:"reasoning_content"`
			Reasoning        string `json:"reasoning"`
			ToolCalls        []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Error *apiError `json:"error"`
}

type apiError struct {
	Message string `json:"message"`
}

// UnmarshalJSON accepts both {"error": "text"} and {"error": {"message": "text"}}.
func (e *apiError) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		e.Message = s
		return nil
	}
	type plain apiError
	return json.Unmarshal(b, (*plain)(e))
}

type LLM struct {
	BaseURL string // e.g. http://localhost:1234/v1
	Token   string // optional API token (LM Studio: Developer → Server Settings → Require Authentication)
	HTTP    *http.Client
}

func (l *LLM) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, l.BaseURL+path, body)
	if err != nil {
		return nil, err
	}
	if l.Token != "" {
		req.Header.Set("Authorization", "Bearer "+l.Token)
	}
	return req, nil
}

// StreamCallbacks receive text as it is generated.
type StreamCallbacks struct {
	Content   func(string)
	Reasoning func(string)
}

// Stream runs one chat completion and returns the complete assistant message.
func (l *LLM) Stream(ctx context.Context, model string, messages []Message, tools []ToolDef, cb StreamCallbacks) (Message, error) {
	body, err := json.Marshal(chatRequest{Model: model, Messages: messages, Tools: tools, Stream: true})
	if err != nil {
		return Message{}, err
	}
	req, err := l.newRequest(ctx, http.MethodPost, "/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Message{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	res, err := l.HTTP.Do(req)
	if err != nil {
		return Message{}, fmt.Errorf("cannot reach the model server at %s: %w", l.BaseURL, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Message{}, fmt.Errorf("model server: %s", errorMessage(res))
	}

	msg := Message{Role: "assistant"}
	var content strings.Builder
	var calls []ToolCall

	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		data, ok := strings.CutPrefix(scanner.Text(), "data:")
		if !ok {
			continue
		}
		data = strings.TrimSpace(data)
		if data == "[DONE]" {
			break
		}
		var chunk streamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return Message{}, fmt.Errorf("bad stream chunk: %w", err)
		}
		if chunk.Error != nil {
			return Message{}, fmt.Errorf("model server: %s", chunk.Error.Message)
		}
		for _, choice := range chunk.Choices {
			d := choice.Delta
			if d.Content != "" {
				content.WriteString(d.Content)
				if cb.Content != nil {
					cb.Content(d.Content)
				}
			}
			if r := d.ReasoningContent + d.Reasoning; r != "" && cb.Reasoning != nil {
				cb.Reasoning(r)
			}
			// Tool calls arrive in fragments keyed by index; arguments are concatenated.
			for _, tc := range d.ToolCalls {
				for len(calls) <= tc.Index {
					calls = append(calls, ToolCall{Type: "function"})
				}
				c := &calls[tc.Index]
				if tc.ID != "" {
					c.ID = tc.ID
				}
				c.Function.Name += tc.Function.Name
				c.Function.Arguments += tc.Function.Arguments
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return Message{}, err
	}

	msg.Content = content.String()
	for i := range calls {
		if calls[i].ID == "" {
			calls[i].ID = fmt.Sprintf("call_%d", i)
		}
		if calls[i].Function.Name != "" {
			msg.ToolCalls = append(msg.ToolCalls, calls[i])
		}
	}
	return msg, nil
}

// Models lists model ids, skipping embedding models.
func (l *LLM) Models(ctx context.Context) ([]string, error) {
	req, err := l.newRequest(ctx, http.MethodGet, "/models", nil)
	if err != nil {
		return nil, err
	}
	res, err := l.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cannot reach the model server at %s: %w", l.BaseURL, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("model server: %s", errorMessage(res))
	}
	var list struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&list); err != nil {
		return nil, err
	}
	var ids []string
	for _, m := range list.Data {
		if !strings.Contains(strings.ToLower(m.ID), "embed") {
			ids = append(ids, m.ID)
		}
	}
	return ids, nil
}

func errorMessage(res *http.Response) string {
	b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	var body struct {
		Error *apiError `json:"error"`
	}
	if json.Unmarshal(b, &body) == nil && body.Error != nil && body.Error.Message != "" {
		return body.Error.Message
	}
	if s := strings.TrimSpace(string(b)); s != "" {
		return fmt.Sprintf("%s: %s", res.Status, s)
	}
	return res.Status
}
