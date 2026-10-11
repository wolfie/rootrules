package main

import (
	"flag"
	"os"
	"path/filepath"
	"testing"
)

func testFlags() (*flag.FlagSet, map[string]*string, *int) {
	fset := flag.NewFlagSet("test", flag.ContinueOnError)
	strs := map[string]*string{
		"lmstudio": fset.String("lmstudio", "http://default", ""),
		"model":    fset.String("model", "", ""),
		"listen":   fset.String("listen", "127.0.0.1:8090", ""),
	}
	return fset, strs, fset.Int("max-steps", 8, "")
}

// unsetAfter removes variables godotenv sets, so tests don't leak into each other.
func unsetAfter(t *testing.T, keys ...string) {
	t.Cleanup(func() {
		for _, k := range keys {
			os.Unsetenv(k)
		}
	})
}

func TestConfigPrecedence(t *testing.T) {
	t.Chdir(t.TempDir())
	file := filepath.Join(t.TempDir(), "chat.env")
	os.WriteFile(file, []byte("LMSTUDIO_URL=http://from-file\nCHAT_MODEL=file-model\nCHAT_MAX_STEPS=3\nCHAT_LISTEN=\n"), 0o600)
	unsetAfter(t, "LMSTUDIO_URL", "CHAT_MAX_STEPS", "CHAT_LISTEN")
	t.Setenv("CHAT_MODEL", "env-model")

	fset, strs, maxSteps := testFlags()
	if err := parseConfig(fset, []string{"-env-file", file, "-max-steps", "5"}); err != nil {
		t.Fatal(err)
	}
	if got := *strs["lmstudio"]; got != "http://from-file" {
		t.Errorf("lmstudio = %q, want value from env file", got)
	}
	if got := *strs["model"]; got != "env-model" {
		t.Errorf("model = %q, want real environment to beat env file", got)
	}
	if *maxSteps != 5 {
		t.Errorf("max-steps = %d, want flag to beat env file", *maxSteps)
	}
	if got := *strs["listen"]; got != "" {
		t.Errorf("listen = %q, want empty value from env file to disable it", got)
	}
}

func TestConfigEnvFileOptionalUnlessExplicit(t *testing.T) {
	t.Chdir(t.TempDir())

	fset, strs, _ := testFlags()
	if err := parseConfig(fset, nil); err != nil {
		t.Fatalf("missing default .env should be ignored: %v", err)
	}
	if got := *strs["lmstudio"]; got != "http://default" {
		t.Errorf("lmstudio = %q, want default", got)
	}

	fset, _, _ = testFlags()
	if err := parseConfig(fset, []string{"-env-file", "nope.env"}); err == nil {
		t.Fatal("missing explicit -env-file should be an error")
	}
}

func TestConfigDefaultEnvFileInWorkingDir(t *testing.T) {
	t.Chdir(t.TempDir())
	os.WriteFile(".env", []byte("CHAT_MODEL=from-dotenv # comment\n"), 0o600)
	unsetAfter(t, "CHAT_MODEL")

	fset, strs, _ := testFlags()
	if err := parseConfig(fset, nil); err != nil {
		t.Fatal(err)
	}
	if got := *strs["model"]; got != "from-dotenv" {
		t.Errorf("model = %q", got)
	}
}

func TestConfigRejectsBadValues(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("CHAT_MAX_STEPS", "lots")
	fset, _, _ := testFlags()
	if err := parseConfig(fset, nil); err == nil {
		t.Fatal("want error for non-numeric CHAT_MAX_STEPS")
	}
}
