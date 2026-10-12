package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBasicAuth(t *testing.T) {
	h := basicAuth("alice", "s3cret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	cases := []struct {
		name, path, user, password string
		withAuth                   bool
		want                       int
	}{
		{"no credentials", "/", "", "", false, http.StatusUnauthorized},
		{"wrong password", "/api/models", "alice", "nope", true, http.StatusUnauthorized},
		{"wrong user", "/api/models", "bob", "s3cret", true, http.StatusUnauthorized},
		{"correct", "/api/models", "alice", "s3cret", true, http.StatusOK},
		{"manifest is public", "/manifest.webmanifest", "", "", false, http.StatusOK},
		{"icon is public", "/icon.svg", "", "", false, http.StatusOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", c.path, nil)
			if c.withAuth {
				req.SetBasicAuth(c.user, c.password)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Fatalf("status %d, want %d", rec.Code, c.want)
			}
			if c.want == http.StatusUnauthorized && rec.Header().Get("WWW-Authenticate") == "" {
				t.Fatal("missing WWW-Authenticate header")
			}
		})
	}
}
