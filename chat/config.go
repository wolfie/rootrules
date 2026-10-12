package main

import (
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"

	"github.com/joho/godotenv"
)

// envVars maps each flag to the environment variable that can set it.
var envVars = map[string]string{
	"lmstudio":       "LMSTUDIO_URL",
	"lmstudio-token": "LM_API_TOKEN",
	"model":          "CHAT_MODEL",
	"rules":          "ROOTRULES_MCP_URL",
	"rules-token":    "ROOTRULES_TOKEN",
	"listen":         "CHAT_LISTEN",
	"ts-hostname":    "TS_HOSTNAME",
	"ts-dir":         "TS_DIR",
	"ts-https":       "TS_HTTPS",
	"max-steps":      "CHAT_MAX_STEPS",
	"auth-user":      "CHAT_AUTH_USER",
	"auth-password":  "CHAT_AUTH_PASSWORD",
}

const defaultEnvFile = ".env"

// parseConfig parses flags with this precedence: command-line flag, process environment,
// env file, built-in default. Variables the program doesn't use as flags (e.g. TS_AUTHKEY,
// read by tsnet) are also loaded from the env file.
func parseConfig(fset *flag.FlagSet, args []string) error {
	envFile := fset.String("env-file", defaultEnvFile, "file with KEY=value lines to load (missing default file is ignored)")
	for name, key := range envVars {
		if f := fset.Lookup(name); f != nil {
			f.Usage += fmt.Sprintf(" (env %s)", key)
		}
	}
	if err := fset.Parse(args); err != nil {
		return err
	}

	set := map[string]bool{}
	fset.Visit(func(f *flag.Flag) { set[f.Name] = true })

	// godotenv.Load never overrides variables already in the environment.
	if err := godotenv.Load(*envFile); err != nil {
		if !errors.Is(err, fs.ErrNotExist) || set["env-file"] {
			return fmt.Errorf("env file %s: %w", *envFile, err)
		}
	}

	for name, key := range envVars {
		if set[name] {
			continue
		}
		// Presence, not emptiness, counts: CHAT_LISTEN= disables the local listener.
		if v, ok := os.LookupEnv(key); ok {
			if err := fset.Set(name, v); err != nil {
				return fmt.Errorf("%s=%q: %w", key, v, err)
			}
		}
	}
	return nil
}
