# Deploying mikeos-designer (the SPA at designer.osmike.com)

This is a **static SPA** — plain HTML/CSS/ES-module JS, no build step, no framework,
no external CDNs. Caddy (on **242**) serves the repo directory directly. Published
user projects live at `designer.osmike.com/<6charid>/` and are served by the
**backend** (`designer-api.osmike.com`) / a separate publish path — NOT by this SPA.

## 1. What Caddy serves

Serve the **repo root** as the site root for `designer.osmike.com`. The SPA's own
assets are all under a prefix so they never collide with 6-char project folders:

```
/                → index.html          (SPA shell)
/app.js          → app.js              (SPA controller, ES module)
/config.js       → config.js           (deploy-adjustable config; edit in place)
/assets/*        → assets/*.js, .css    (auth, api, mock, highlight, zip, styles)
```

Everything the SPA loads is under `/`, `/app.js`, `/config.js`, `/assets/*`. A
6-char project id can never be one of those names, so there is no collision.

## 2. SPA routing rule (IMPORTANT)

The app uses two client-side routes that must both fall back to `index.html`:
- `/`                — the builder
- `/auth/callback`   — the OAuth redirect target (PKCE code lands here)

Anything else (a `/<id>/...` path) is a **published project** and must be served
from disk / proxied to the publish backend, NOT rewritten to the SPA.

### Caddyfile (recommended)

```caddy
designer.osmike.com {
    root * /opt/mikeos/designer            # <-- where you deploy this repo
    encode gzip

    # SPA routes: serve index.html for the app root and the OAuth callback.
    @spa path / /auth/callback
    handle @spa {
        rewrite * /index.html
        file_server
    }

    # Everything else (the SPA's own assets AND the /<id>/ published sites)
    # is served straight from disk. Published projects are written into
    # subfolders here by the backend, OR reverse_proxy them to designer-api
    # if the backend hosts them — pick ONE of the two blocks below.
    handle {
        file_server
    }

    # --- If published sites are hosted by the backend instead of on disk,
    # --- replace the `handle { file_server }` above with:
    # @project path_regexp proj ^/[A-Za-z0-9]{6}(/.*)?$
    # handle @project {
    #     reverse_proxy https://designer-api.osmike.com   # or the internal upstream
    # }
    # handle { file_server }
}
```

Key point: **only `/` and `/auth/callback` rewrite to index.html.** Do NOT use a
catch-all `try_files {path} /index.html` — that would shadow published `/<id>/`
sites with the SPA shell.

## 3. config.js — exact PRODUCTION values

`config.js` is plain JS loaded before the app; edit it in place on the server, no
rebuild needed. All values are public (PKCE = no secret in the browser).

```js
window.DESIGNER_CONFIG = {
  API_BASE:     "https://designer-api.osmike.com",
  ISSUER:       "https://account.osmike.com",
  CLIENT_ID:    "designer-web",
  REDIRECT_URI: "https://designer.osmike.com/auth/callback",
  SCOPE:        "openid profile email",
  AUDIENCE:     "designer",
  MOCK:         false
};
```

These are already the committed defaults — **no edit is needed for production.**
`MOCK` must be `false` in production (it stubs the API + skips auth; dev only).

## 4. OAuth client registration at account.osmike.com

The coordinator has **already registered** this public client in the live identity
DB. For reference / disaster recovery, the registration is:

| Field | Value |
|---|---|
| `client_id` | `designer-web` |
| client type | public (PKCE), `token_endpoint_auth_method = none` (no secret) |
| PKCE | required, `S256` |
| `redirect_uris` | `https://designer.osmike.com/auth/callback` **and** `http://localhost:8080/auth/callback` (dev) |
| `scope` | `openid profile email` |
| tokens | RS256 access tokens (validated by designer-api via JWKS) |

Endpoints (from `https://account.osmike.com/.well-known/openid-configuration`):
- authorize: `https://account.osmike.com/oauth/authorize`
- token:     `https://account.osmike.com/oauth/token`
- jwks:      `https://account.osmike.com/oauth/jwks.json`
- userinfo:  `https://account.osmike.com/oauth/userinfo`

### CORS requirement (one thing to confirm on the AS)
Because this is a pure browser SPA with no backend of its own, the **code→token
exchange goes directly** from the browser to `POST https://account.osmike.com/oauth/token`.
The AS's token endpoint must therefore send CORS headers allowing the origin
`https://designer.osmike.com` (and `http://localhost:8080` for dev):
`Access-Control-Allow-Origin: https://designer.osmike.com`. If the AS does not yet
allow this origin, add it — otherwise the token exchange will be blocked by the
browser (the authorize redirect itself is unaffected).

## 5. designer-api (resource server)

The SPA sends `Authorization: Bearer <RS256 JWT>` on every `/api/*` call except
`/api/health` and `/api/meta`. The backend validates the JWT locally via the JWKS
above (`aud = designer`), exactly per `ecosystem/AUTHENTICATION.md` ROLE 1. The
backend must also allow CORS from `https://designer.osmike.com` for all `/api/*`.

## 6. Local dev + real end-to-end OAuth test

```bash
python3 -m http.server 8080     # serve the repo on the registered dev origin
# then open http://localhost:8080/  and click "Login with MikeOS"
```
`http://localhost:8080/auth/callback` is a registered redirect URI, so a REAL login
against account.osmike.com works locally. `auth.js` auto-switches its `redirect_uri`
to the localhost value when served from `localhost:8080`, so the SAME `config.js`
drives dev and prod. (For the SPA-fallback of `/auth/callback` under `http.server`,
the callback query still lands on `/` cleanly because the app also triggers on a
`?code=` param; for a faithful Caddy-style test, front it with the Caddyfile above.)

Add `?mock=1` to any URL to run the full UI with a stubbed API and no auth — used
for the visual verification (generate → preview/code → publish/download → projects).
```
```
