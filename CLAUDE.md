# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
cp .dev.vars.example .dev.vars   # first-time setup: add OPENAI_API_KEY
npm install
npm run dev        # start local dev server (first run builds Docker image: 2-3 min)
npm run start      # same as dev but without the egress image override
npm run typecheck  # tsc --noEmit
npm run test:unit  # fast launcher/bootstrap tests; no Docker, Wrangler, or credentials
npm test           # unit tests, then WebSocket integration tests via wrangler dev
npm run test:egress  # validate egress constraints via wrangler dev
```

Deploy:
```bash
wrangler secret put OPENAI_API_KEY
npm run deploy
```

## Architecture

This is a Cloudflare Worker that acts as a WebSocket middleman between a browser client and an OpenAI Codex `app-server` process running inside a Cloudflare Sandbox container.

**Key files:**
- `src/index.ts` — Worker entrypoint: `Sandbox` Durable Object subclass, egress handlers, WebSocket bridge, `sandboxSetup`/`sandboxExec` custom RPC handlers
- `src/rpc.ts` — JSON-RPC types and composable handler pipeline (`compose`, `log`, `enforceModel`, `enforcePolicy`, `autoApprove`)
- `public/index.html` — Single-file vanilla JS browser client
- `Dockerfile` — Container image: `cloudflare/sandbox` base + `@openai/codex` CLI
- `scripts/sandbox-agent.mjs` — Local `sagent`/`sclaude`/`scodex` launcher for starting a Sandbox session and `docker exec`ing into the local container
- `test/` — Node test suites split into fast unit/bootstrap tests and Wrangler-backed integration tests

**Handler pipeline:** Every JSON-RPC message through the WebSocket bridge passes through `compose(...handlers)`. Each handler returns the message (possibly rewritten), or `null` to drop it (after optionally calling `ctx.sendToClient`/`ctx.sendToServer`). Direction is `'client-to-server'` or `'server-to-client'`.

**Security model:**
- `enableInternet = false` — blocks all direct outbound TCP from the container
- `interceptHttps = true` — Cloudflare CA cert injected so HTTPS also flows through egress handlers
- `Sandbox.outboundByHost` allowlist: `api.openai.com` (injects real API key, upgrades to HTTPS), `github.com` (upgrades to HTTPS)
- `Sandbox.outbound` catch-all: returns 403
- The container uses a dummy `OPENAI_API_KEY=proxy-injected`; the real key lives only in the Worker env

**Session lifecycle:** Each `/ws/<session-name>` connects to a distinct Durable Object (`codex-<session-name>`). On every WebSocket connection, the existing sandbox is destroyed, Codex `app-server` is started fresh on port 4500, and the Worker bridges frames through the pipeline.

**Local CLI lifecycle:** `npm run sagent`, `npm run sclaude`, and `npm run scodex` share `scripts/sandbox-agent.mjs`. The launcher opens the Worker WebSocket path to start/setup the sandbox, then separately runs `docker exec` into the local container. Use `--no-tty` for non-interactive automation.

**Local vs. deployed behavior:** `wrangler dev` now supports full outbound interception via a TPROXY sidecar inside the sandbox's network namespace, mirroring production behavior. The dev script sets `MINIFLARE_CONTAINER_EGRESS_IMAGE` for the local container image.
