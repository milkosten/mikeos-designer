# mikeos-designer

The **SPA frontend** for MikeOS Designer — a Replit-style **prompt → website**
builder, served at **`designer.osmike.com`**. Backend is a separate service at
**`designer-api.osmike.com`** (repo `mikeos-designer-cloud`).

Static, dependency-light, **no external CDNs** — everything is vendored locally.
Plain HTML + CSS + ES-module JavaScript. No build step.

## What it does

A split-view builder:
- **Left:** a prompt textarea, page-type + style dropdowns (from `GET /api/meta`),
  a **Generate** button, a prompt-only **Refine** chat, and a **My Projects** list.
- **Right:** **Preview** (live `<iframe>` of the generated site) / **Code**
  (read-only, syntax-highlighted HTML, with per-page sub-tabs for multi-page
  projects). **Publish** (get the shareable `designer.osmike.com/<id>/` link) and
  **Download** (single `.html`, or a client-side `.zip` for multi-page).
- A **Login with MikeOS** screen when unauthenticated.

## Auth

OAuth 2.0 **Authorization Code + PKCE (S256)** against `account.osmike.com`
(public client `designer-web`, no secret in the browser). Access token in
`sessionStorage`, sent as `Authorization: Bearer <JWT>` to `designer-api`.
See `DEPLOY.md` for the client registration and CORS requirement.

## Files

| File | Purpose |
|---|---|
| `index.html` | SPA shell |
| `config.js` | deploy-adjustable config (API base, issuer, client id, redirect, scopes) |
| `app.js` | the SPA controller (state + rendering) |
| `assets/auth.js` | OAuth PKCE flow |
| `assets/api.js` | designer-api client (Bearer) |
| `assets/mock.js` | `?mock=1` in-memory API stub (dev only) |
| `assets/highlight.js` | tiny self-contained HTML syntax highlighter |
| `assets/zip.js` | tiny self-contained ZIP writer (multi-page download) |
| `assets/styles.css` | dark UI |

## Develop

```bash
python3 -m http.server 8080
# http://localhost:8080/?mock=1   -> full UI with a stubbed API, no login
# http://localhost:8080/          -> real "Login with MikeOS" (localhost:8080 is a registered redirect)
```

## Deploy

See **`DEPLOY.md`** — Caddy config, the SPA routing rule (`/` and `/auth/callback`
→ `index.html`; `/<id>/` = published projects), production `config.js` values, and
the account.osmike.com client registration + CORS requirement.
