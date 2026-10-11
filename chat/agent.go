package main

// The tool-calling loop: the model researches with the rules tools until it can answer.

import (
	"context"
	"fmt"
	"strings"
)

const chatPrompt = `You are a rules arbiter for the board game Root, answering in a chat on the player's phone during a game.

Answer format:
**Ruling:** the answer in one or two sentences.
**Why:** short reasoning that quotes the deciding rule text.
**Caveats:** only if the rules leave something open or more information would change the ruling.

Cite every rule as §<id> (e.g. §4.3.1, §G.24) and FAQ entries as FAQ-<n>; the player taps these to read the source.
Be concise. If the question is not about Root rules, say briefly that you only arbitrate Root rules.`

// Event types streamed to the browser.
const (
	evStep       = "step"        // a new model call starts
	evDelta      = "delta"       // answer text
	evReasoning  = "reasoning"   // model's thinking, if the server reports it separately
	evToolCall   = "tool_call"   // {id, name, arguments}
	evToolResult = "tool_result" // {id, name, text, isError}
	evDone       = "done"
	evError      = "error"
)

type Agent struct {
	LLM      *LLM
	Rules    *Rules
	MaxSteps int
}

type Emit func(event string, data any)

// Run answers the last user message in history, streaming progress through emit.
func (a *Agent) Run(ctx context.Context, model string, history []Message, emit Emit) error {
	tools, err := a.Rules.Open(ctx)
	if err != nil {
		return err
	}
	defer tools.Close()

	system := chatPrompt
	if tools.Instructions != "" {
		system = tools.Instructions + "\n\n" + chatPrompt
	}
	messages := append([]Message{{Role: "system", Content: system}}, history...)

	for step := 1; ; step++ {
		// On the last step, withhold the tools so the model has to answer.
		final := step >= a.MaxSteps
		stepTools := tools.Tools
		if final {
			stepTools = nil
			messages = append(messages, Message{
				Role:    "system",
				Content: "Research budget used up. Answer now from what you have found, and say what remains uncertain.",
			})
		}

		emit(evStep, map[string]any{"step": step, "final": final})
		reply, err := a.LLM.Stream(ctx, model, messages, stepTools, StreamCallbacks{
			Content:   func(s string) { emit(evDelta, map[string]string{"text": s}) },
			Reasoning: func(s string) { emit(evReasoning, map[string]string{"text": s}) },
		})
		if err != nil {
			return err
		}
		if len(reply.ToolCalls) == 0 {
			if strings.TrimSpace(reply.Content) == "" {
				return fmt.Errorf("the model returned an empty answer (check that it supports tool use and has enough context length)")
			}
			emit(evDone, map[string]any{"steps": step})
			return nil
		}

		messages = append(messages, reply)
		for _, call := range reply.ToolCalls {
			emit(evToolCall, map[string]string{"id": call.ID, "name": call.Function.Name, "arguments": call.Function.Arguments})
			text, isError := tools.Call(ctx, call.Function.Name, call.Function.Arguments)
			emit(evToolResult, map[string]any{"id": call.ID, "name": call.Function.Name, "text": text, "isError": isError})
			messages = append(messages, Message{Role: "tool", ToolCallID: call.ID, Content: text})
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
}
