package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
)

// publicPaths are served without authentication: browsers fetch the web app manifest without
// credentials, so "Add to Home Screen" would otherwise lose the app name and icon.
var publicPaths = map[string]bool{
	"/manifest.webmanifest": true,
	"/icon.svg":             true,
}

// basicAuth requires HTTP basic authentication with the given credentials.
func basicAuth(user, password string, h http.Handler) http.Handler {
	wantUser := sha256.Sum256([]byte(user))
	wantPassword := sha256.Sum256([]byte(password))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if publicPaths[r.URL.Path] {
			h.ServeHTTP(w, r)
			return
		}
		u, p, ok := r.BasicAuth()
		gotUser := sha256.Sum256([]byte(u))
		gotPassword := sha256.Sum256([]byte(p))
		// Compare both, always, so timing doesn't reveal which one was wrong.
		userOK := subtle.ConstantTimeCompare(gotUser[:], wantUser[:])
		passwordOK := subtle.ConstantTimeCompare(gotPassword[:], wantPassword[:])
		if !ok || userOK&passwordOK != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="rootrules-chat", charset="UTF-8"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		h.ServeHTTP(w, r)
	})
}
