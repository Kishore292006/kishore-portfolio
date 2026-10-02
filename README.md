# Kishore Portfolio

A single-page portfolio (`index.html`) served by a zero-dependency Node server (built-ins only, Node >= 18.17).

## Run

```sh
npm start            # or: node server.js
# -> http://127.0.0.1:4200
```

## Environment variables

| Var        | Default       | Notes |
|------------|---------------|-------|
| `PORT`     | `4200`        | Hosting platforms set this for you. |
| `HOST`     | `127.0.0.1`   | Loopback only by default. Use `0.0.0.0` in containers / PaaS. |
| `DATA_DIR` | `./data`      | Where `stats.json` lives. Point at a persistent disk in production. |

## Routes

| Route | Description |
|-------|-------------|
| `GET /`, `/index.html` | The site (`no-cache`, ETag, gzip/brotli) |
| `GET /Mattapalli_Kishore_Resume.pdf` | Resume, inline. Add `?download=1` to force a download. Counted. |
| `GET /assets/*`, `/public/*` | Static files, only if those folders exist (1 day cache) |
| `GET /api/stats` | `{"resumeDownloads": n, "since": "<iso>"}` (`no-store`) |
| `GET /api/health` | `{"status":"ok","uptime":<seconds>}` |

Only GET and HEAD are accepted (others get 405). Everything else, including `server.js`, `package.json`, `README.md`, `data/` and dotfiles, returns 404. Traversal attempts (`..`, encoded `..`, null bytes, backslashes) return 400.

Every response carries a CSP (inline scripts/styles plus cdnjs, Google Fonts), `nosniff`, a strict referrer policy, a Permissions-Policy that disables camera/mic/geolocation, and COOP `same-origin`.

## Download counter

Each completed `GET` of the resume PDF (not `HEAD`, not a `304`) bumps an in-memory counter and persists it to `data/stats.json` via a temp file + atomic rename. Writes are serialised and coalesced, so concurrent downloads never lose counts. A missing or corrupted file is tolerated (a corrupt one is copied to `stats.json.corrupt` and counting restarts at 0). No IPs or user agents are stored or logged; the request log is `method path status ms` only. `data/stats.json` is git-ignored.

SIGINT/SIGTERM trigger a graceful shutdown: stop accepting, finish in-flight requests, flush the counter.

## Deployment options

1. **Render / Railway / Fly.io (full feature set).** Start command `npm start`, set `HOST=0.0.0.0` (the platform provides `PORT`). Attach a small persistent volume and set `DATA_DIR` to it, otherwise the counter resets on each deploy.
2. **Docker on any VPS.** `node:20-alpine`, copy the folder, `ENV HOST=0.0.0.0`, mount a volume at `/app/data`, put Caddy or nginx in front for HTTPS (then add an HSTS header there).
3. **GitHub Pages / Netlify (static only).** Publish `index.html` and the PDF. The page works, but `/api/stats`, the counter and the security headers from this server are not available (set headers via Netlify `_headers` instead), so the front end must handle the missing API gracefully.
