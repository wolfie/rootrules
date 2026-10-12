# rootrules-chat

A small chat app for arbitrating Root rules at the table, from your phone. It's a single Go binary with the web
UI embedded.

```
phone ──tailnet (HTTPS)──▶ rootrules-chat ──▶ LM Studio            (the model)
                                         └──▶ rootrules server /mcp (rules tools)
```

The backend runs the tool loop itself:

1. It connects to the rules server's MCP tools.
2. It sends them to LM Studio's OpenAI-compatible API.
3. It runs the tool calls the model makes, until the model answers.
4. It streams everything to the browser.

LM Studio doesn't have to be running all the time. The UI checks `GET /api/health` every 15 seconds while it's open,
and as soon as you come back to it. A banner says when LM Studio or the rules server isn't answering and
disappears once it's back. The model list fills in when LM Studio comes up.

In the UI you can watch the lookups happen. Citations like §4.3.1 or FAQ-4 in the answer are tappable and open
the actual rule text, so you can check the model against the Law.

## Requirements

- Go 1.27+ to build. An older `go` (1.21+) downloads 1.27 automatically on the first build, as long as
  `GOTOOLCHAIN=auto` (the default).
- The rules server running, default `http://localhost:8787/mcp`. In the repo root, run
  `npm install && npm run update && npm start` (see [Getting started](../README.md#getting-started)). The server
  won't start until `npm run update` has generated `dist/`.
- LM Studio with its local server running (Developer tab) and a model that supports tool calling.
  - Load the model with **at least 16k context length** (32k is better). Rule lookups return a few thousand
    tokens each, and LM Studio's default 4k context overflows quickly.
  - If "Require Authentication" is on in LM Studio, pass its API token as `LM_API_TOKEN`.

## Run

```sh
cd chat
cp .env.example .env    # then fill in LM_API_TOKEN etc.
go build -o rootrules-chat .

./rootrules-chat                          # local only: http://127.0.0.1:8090
./rootrules-chat -ts-hostname rootrules   # also https://rootrules.<tailnet>.ts.net
```

Settings come from, in order of precedence: command-line flags, environment variables, the `.env` file in the
working directory (or `-env-file path`), then defaults. `.env` is git-ignored. It can also hold variables used
by libraries, such as `TS_AUTHKEY`.

On the first Tailscale run, the log prints a login URL. Open it to add the device to your tailnet, or set
`TS_AUTHKEY` to an auth key instead. The node state is kept in `~/.config/rootrules-chat/tsnet`, so this
happens once.

For HTTPS, enable MagicDNS and HTTPS certificates in the Tailscale admin console (DNS page). Otherwise run with
`-ts-https=false` for plain HTTP on the tailnet. The first HTTPS request can take a few seconds while the
certificate is issued.

On the phone, open the URL, then add it to the home screen: Share → Add to Home Screen on iOS, ⋮ → Install app
on Android. It then opens like an app.

By default the app has no login: it's only reachable from your tailnet (and from localhost). Keep `-listen` on
127.0.0.1 unless you want everyone on your LAN to have access to your model.

To require a password anyway, for example on a shared tailnet or a LAN listener, set `CHAT_AUTH_USER` and
`CHAT_AUTH_PASSWORD` (or `-auth-user`/`-auth-password`). The browser then asks for them once and remembers them.
Basic auth sends the password with every request, so use it over HTTPS or the tailnet (which is encrypted), not
plain HTTP on a LAN you don't trust. The web app manifest and icon stay public so "Add to Home Screen" works.

## Options

| Flag              | Env                 | Default                                                                       |
| ----------------- | ------------------- | ----------------------------------------------------------------------------- |
| `-lmstudio`       | `LMSTUDIO_URL`      | `http://localhost:1234/v1`                                                    |
| `-lmstudio-token` | `LM_API_TOKEN`      | none                                                                          |
| `-model`          | `CHAT_MODEL`        | first model LM Studio lists (also selectable in the UI)                       |
| `-rules`          | `ROOTRULES_MCP_URL` | `http://localhost:8787/mcp`                                                   |
| `-rules-token`    | `ROOTRULES_TOKEN`   | none                                                                          |
| `-listen`         | `CHAT_LISTEN`       | `127.0.0.1:8090`; set it empty (`CHAT_LISTEN=`) to serve only on the tailnet  |
| `-ts-hostname`    | `TS_HOSTNAME`       | none (Tailscale off)                                                          |
| `-ts-dir`         | `TS_DIR`            | `~/.config/rootrules-chat/tsnet`                                              |
| `-ts-https`       | `TS_HTTPS`          | `true`                                                                        |
| `-max-steps`      | `CHAT_MAX_STEPS`    | `8` model calls per answer, the last one without tools so it must answer      |
| `-auth-user`      | `CHAT_AUTH_USER`    | none (no login); set together with `-auth-password` to require basic auth     |
| `-auth-password`  | `CHAT_AUTH_PASSWORD`| none                                                                          |
| `-env-file`       |                     | `.env`; a missing default file is ignored, a missing explicit one is an error |

### WSL2

With `networkingMode=mirrored` in `.wslconfig`, LM Studio on Windows is reachable at `localhost:1234` from WSL,
and the defaults work. Without mirrored networking, enable "Serve on Local Network" in LM Studio and point
`-lmstudio` at the Windows host IP.

The Tailscale node runs inside the binary, independently of any Tailscale install on Windows.

## Development

```sh
go test ./...   # agent loop against a fake model and an in-process MCP server
go vet ./...
```

Frontend files are in `web/` (plain HTML/CSS/JS, embedded at build time), so rebuild after editing them.
