package main

// The tool-calling loop: the model researches with the rules tools until it can answer.

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

const chatPrompt = `You are a rules arbiter for the board game Root, answering in a chat on the player's phone during a game.

Grounding, which matters more than anything else:
- Your only source is the text the rules tools return in this conversation. Your own memory of Root is not a source:
  it may be wrong, outdated or from another printing, even when it feels certain.
- Research before every rules answer. Use search_rules, then get_rules on the candidates to read the full text,
  sub-rules, FAQ and errata. Follow cross-references, and check faction rules, cards and the Golden Rules that could
  override a general rule. If a search misses, try other wordings, synonyms and the game terms (lookup_term).
- Every statement in a ruling must be backed by retrieved text that you quote. Cite only rule and FAQ ids that
  appeared in tool results.
- Don't fill gaps with inference, analogy, "probably", common sense or how other games work. You may chain rules
  together only if every link is stated in retrieved text, and then you must show the chain.
- A wrong ruling is far worse than no ruling. If the retrieved text doesn't clearly settle the question, say that you
  couldn't find a ruling, even if you think you know the answer.

When the retrieved rules settle the question, answer:
**Ruling:** the answer in one or two sentences.
**Why:** short reasoning that quotes the deciding rule text.
**Caveats:** only if part of the question is left open, or more information would change the ruling.

When they don't, answer:
**No ruling found:** one sentence on what the rules you found don't settle.
**Related rules:** what the retrieved text does say that bears on it, quoted and cited, without drawing a conclusion.
Omit this if nothing relevant was found.

Cite every rule as §<id> (e.g. §4.3.1, §G.24) and FAQ entries as FAQ-<n>; the player taps these to read the source.
Be concise. If the question is not about Root rules, say briefly that you only arbitrate Root rules.`

// Event types streamed to the browser.
const (
	evStep       = "step"        // a new model call starts
	evDelta      = "delta"       // answer text
	evReasoning  = "reasoning"   // model's thinking, if the server reports it separately
	evToolCall   = "tool_call"   // {id, name, arguments}
	evToolResult = "tool_result" // {id, name, text, isError}
	evRetract    = "retract"     // the answer so far is withdrawn: {reason}
	evWarning    = "warning"     // the final answer failed a check: {message, unverified}
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

	// Everything the tools returned this turn; the answer may only cite ids that appear here.
	var retrieved strings.Builder
	researched, nudged := false, false

	for step := 1; ; step++ {
		// On the last step, withhold the tools so the model has to answer.
		final := step >= a.MaxSteps
		stepTools := tools.Tools
		if final {
			stepTools = nil
			messages = append(messages, Message{Role: "system", Content: budgetPrompt})
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
			// LM Studio ignores tool_choice "required", so enforce research here: an answer given
			// without any lookup is withdrawn once. The second one is accepted (e.g. off-topic).
			if !researched && !nudged && !final {
				nudged = true
				emit(evRetract, map[string]string{"reason": "Answered without looking anything up; sent back to research."})
				messages = append(messages, Message{Role: "system", Content: researchPrompt})
				continue
			}
			if unverified := unverifiedCitations(reply.Content, retrieved.String()); len(unverified) > 0 {
				emit(evWarning, map[string]any{
					"message":    "This answer cites " + strings.Join(unverified, ", ") + ", which the lookups never returned. Check it against the rules before relying on it.",
					"unverified": unverified,
				})
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
			if !isError {
				researched = true
				retrieved.WriteString(text + "\n")
			}
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
}

const researchPrompt = `You answered without consulting the rules tools. Your memory is not a source. ` +
	`If the question is about Root, research it with the tools now and answer only from what they return. ` +
	`If it isn't about Root, repeat that you only arbitrate Root rules.`

const budgetPrompt = `Research budget used up. Answer only from the text the tools returned. ` +
	`If it doesn't clearly settle the question, use the "No ruling found" format instead of guessing.`

var (
	thinkBlock = regexp.MustCompile(`(?s)<think>.*?(</think>|$)`)
	ruleCite   = regexp.MustCompile(`§\s*([A-Z0-9]+(?:\.[A-Za-z0-9]+)*)`)
	faqCite    = regexp.MustCompile(`\bFAQ-\d+\b`)
	// Tool output also writes ids without §: sub-rules ("**4.3.1.1 Foil Ambush.**"), paths, context.
	dottedID = regexp.MustCompile(`\b[A-Z0-9]+(?:\.[A-Za-z0-9]+)+\b`)
)

// unverifiedCitations returns the rule and FAQ ids cited in answer that never appeared in the
// retrieved tool output: likely invented, or recalled from memory instead of looked up.
func unverifiedCitations(answer, retrieved string) []string {
	answer = thinkBlock.ReplaceAllString(answer, "")
	seen := map[string]bool{}
	markSeen := func(id string) {
		// A retrieved rule's parents count too: its path shows them, and citing the section is fair.
		for {
			seen["§"+id] = true
			i := strings.LastIndex(id, ".")
			if i < 0 {
				return
			}
			id = id[:i]
		}
	}
	for _, m := range ruleCite.FindAllStringSubmatch(retrieved, -1) {
		markSeen(m[1])
	}
	for _, id := range dottedID.FindAllString(retrieved, -1) {
		markSeen(id)
	}
	for _, id := range faqCite.FindAllString(retrieved, -1) {
		seen[id] = true
	}
	var cited []string
	for _, m := range ruleCite.FindAllStringSubmatch(answer, -1) {
		cited = append(cited, "§"+m[1])
	}
	cited = append(cited, faqCite.FindAllString(answer, -1)...)

	var missing []string
	for _, id := range cited {
		if !seen[id] && !slices.Contains(missing, id) {
			missing = append(missing, id)
		}
	}
	return missing
}
