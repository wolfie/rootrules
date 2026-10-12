package main

import (
	"slices"
	"testing"
)

func TestUnverifiedCitations(t *testing.T) {
	retrieved := "## §4.3.1 Step 1: Defender May Ambush\nPath: 4 Key Actions › 4.3 Battle\n\n" +
		"### Sub-rules\n\n**4.3.1.1 Foil Ambush.** The attacker may also play an ambush card.\n\n" +
		"#### FAQ-4\n**Q:** ...\nRefers to: §G.24 [Rule], 9.2.9.IIIa"

	cases := []struct {
		name, answer string
		want         []string
	}{
		{"all retrieved", "**Ruling:** yes, per §4.3.1 and FAQ-4.", nil},
		{"sub-rule without § in output", "See §4.3.1.1.", nil},
		{"parent of a retrieved rule", "Battle (§4.3) works like this; see §4.", nil},
		{"cross-reference and printed form", "§G.24 and §9.2.9.IIIa", nil},
		{"invented rule and FAQ", "Per §7.2.1 and FAQ-12, and again §7.2.1.", []string{"§7.2.1", "FAQ-12"}},
		{"child of a retrieved rule was not read", "§4.3.1.2 says so.", []string{"§4.3.1.2"}},
		{"citations in thinking are ignored", "<think>maybe §8.8.8?</think>**No ruling found:** nothing on this.", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := unverifiedCitations(c.answer, retrieved); !slices.Equal(got, c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}
