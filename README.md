# The Wall Dev

<p>
  <img src="assets/badges/license.svg" alt="License: MIT" height="31">
  <img src="assets/badges/typescript.svg" alt="Extension: TypeScript" height="31">
  <img src="assets/badges/rust.svg" alt="Backend: Rust" height="31">
  <img src="assets/badges/bun.svg" alt="Build: Bun" height="31">
  <img src="assets/badges/postgresql.svg" alt="Store: PostgreSQL" height="31">
  <a href="https://discord.gg/filian"><img src="assets/badges/snackers-hq.svg" alt="Discord: Snackers HQ" height="31"></a>
  <a href="https://discord.gg/snackersru"><img src="assets/badges/snackers-ru.svg" alt="Discord: Snackers RU" height="31"></a>
</p>

A Win95-styled browser extension (and Tampermonkey userscript) for **The Wall** at
[filianislost.com](https://filianislost.com) — a 6000×4200 collaborative pixel
canvas. It overlays your template on the board, shows you exactly which pixels
are still wrong, and adds clans, shared templates, account linking and bot
notifications through a small Rust backend. A static landing site rounds it out.

**Author:** [VAI_PROG](https://github.com/VAIPROG) (VAI_PROG (Vadim)) · MIT licensed

## Community

The Wall is the Snackers community's canvas. Come hang out:

- **Snackers HQ** — https://discord.gg/filian
- **Snackers RU** (Russian-speaking) — https://discord.gg/snackersru

---

## Features

### Overlay & drawing

- Image overlay with automatic quantization to the 34-colour Wall palette
- Pixel-precise placement (X/Y in canvas units), scaling from 5% to 1000% with presets
- "Dots" mode — render only the missing pixels as small markers so the live board stays readable
- Bresenham line and rectangle guides for hand placement
- `the-wall-dev://` share links for one-click import + teleport to coordinates

### Templates & animation

- Catalogue with public / clan / **personal** scopes
- Password-protected share codes — hand someone an id + password to load even a private template
- Animated templates: sprite-sheet layout, row/column/serpentine order, per-frame timing
- Template-vs-board diff and multi-pass "fix" of protected regions, with watched zones that alert on damage
- Import/export in both The Wall Dev and Charity formats

### Accounts, clans & social

- Telegram (OIDC) and Discord (OAuth2) account linking and sign-in
- Optional bot DMs (paint-refill reminders, grief alerts) once you've started the bot
- Live clan chat (Markdown, emotes, @mentions) over Server-Sent Events, shared clan template library, roster, announcements, moderation
- Profile with custom/Discord avatar, Markdown bio, social links, and an achievements system

### Notifications & extras

- Unified mailbox: DMs / news / alerts / modmail, with unread badges and bulk read
- OS notifications with a Win95-toast fallback; optional paint-refill sound
- English + Russian UI, with an optional remote dictionary from the backend
- Wall snapshots, 7TV emote channels, and an update checker

---

## Architecture

| Layer | Stack | Role |
|-------|-------|------|
| **Extension** | TypeScript, bundled with esbuild via `build.ts` | Injects the overlay UI into filianislost.com, mirrors the board WebSocket read-only, relays the site token to the backend |
| **Backend** | Rust (Axum + SQLx + PostgreSQL) | `/api/v2` REST, Telegram/Discord OAuth + bots, JWT sessions, mailbox, templates, clans, snapshots, achievements |
| **Landing** | Static HTML/CSS/JS in `landing/` | Install page, OAuth callback (`/vai-auth/`), and API docs (Swagger/Redoc) |

The extension and backend share no code — they talk over REST/JSON. The
extension never pushes paint through the backend; placing pixels always goes
through the game's own client and its rate limits.

---

## Quick start

### Extension

Requires [Bun](https://bun.sh) — `build.ts` uses Bun APIs, so plain Node won't run it.

```sh
bun install
bun run build        # dev build into dist/
```

`dist/` then contains:

- `extension-chrome/` — load unpacked (Chrome 111+)
- `extension-firefox/` — load as a temporary add-on (Firefox 128+)
- `the-wall-dev.user.js` — drop into Tampermonkey/Violentmonkey

Live-rebuild while hacking:

```sh
bun run watch
```

Dev builds expose a `window.__wallDev` console API (config poking, raw backend
calls, region capture, palette/diff helpers); it's tree-shaken out of release
builds entirely.

### Backend

Requires Rust 1.85+ (the crate is on edition 2024) and PostgreSQL 14+.

```sh
cd backend
cp example.env .env      # fill in DATABASE_URL + JWT_SECRET; OAuth keys optional
cargo run
```

Migrations in `backend/migrations/` run automatically at boot. Every optional
integration (Telegram, Discord, snapshots…) degrades gracefully — leave its
keys blank and the boot log tells you which features stayed off.

---

## Build modes

`build.ts` drives four modes; each runs a `tsc --noEmit` gate first (except dev).

| Mode | Command | What you get |
|------|---------|--------------|
| Dev | `bun run build` | Sourcemaps, console logs, `__wallDev` API |
| Release | `bun run release` | Whitespace/syntax minify, console stripped, readable |
| Smallest | `bun run smallest` | Full minify + identifier mangling |
| Publish | `bun run publish` | Builds **release + smallest** together, with suffixed zips and a combined `signature.json` |

Flags: `--watch` (dev live-rebuild), `--no-typecheck` (skip the gate), `--no-zip`.

`publish` writes both variants to `dist/` — `extension-<browser>-release.zip`,
`extension-<browser>-smallest.zip`, the `*.user.js` / `*.min.user.js`
userscripts, and keeps the unsuffixed names as aliases of the release build.

---

## Scripts

| Script | Does |
|--------|------|
| `bun run build` | Dev build |
| `bun run build:release` / `release` | Release build |
| `bun run build:smallest` / `smallest` | Smallest build |
| `bun run publish` | Release + smallest in one pass |
| `bun run watch` | Dev rebuild on `src/` changes |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | Test runner: typecheck gate + extension tests |
| `bun run test:extension` | Extension tests only |
| `bun run test:backend` | Backend `cargo test` |
| `bun run test:backend:live` | Backend live tests (the `#[ignore]`d ones) |
| `bun run test:all` | Extension + backend |
| `bun run openapi` | Regenerate the OpenAPI spec from the route table |

---

## Testing

The extension tests are assertion scripts under `tests/extension/`; the runner
(`scripts/test.ts`) executes each in its own Bun process and prints a tidy,
timed report:

```sh
bun run test               # typecheck + extension tests
bun run test:all           # + cargo test
bun run test -- --filter tiles    # only matching files
```

Backend tests live in `tests/backend/`. `env_contract` runs offline (it checks
`example.env` against the env-key whitelist in `main.rs`); the `api_smoke`
tests are `#[ignore]`d HTTP checks you point at a running server:

```sh
WALL_TEST_BASE_URL=https://the-wall.vai-rice.space \
  cargo test --manifest-path backend/Cargo.toml -- --ignored
```

---

## API documentation

The OpenAPI 3.1 spec is generated from the backend route table in
`backend/src/main.rs` by `scripts/gen-openapi.ts`:

```sh
bun run openapi
```

It writes `spec/openapi.yaml` (source of truth) and `landing/openapi.yaml`
(served at `/openapi.yaml`, with Swagger UI and Redoc under
[`/api-docs/`](https://the-wall.vai-rice.space/api-docs/)). Hand-edited path
blocks survive regeneration; generated stubs are marked `x-generated: true`.

---

## Deployment

`deploy.sh` deploys straight from this repository — no manual upload step. It
clones the repo into `/opt/the-wall`, builds the crate from
`/opt/the-wall/backend`, and wires up systemd + nginx. Run it as root on a
fresh Debian/Ubuntu box:

```sh
sudo ./deploy.sh all        # first-time setup: deps, Rust, Postgres, clone, build, nginx, TLS
sudo ./deploy.sh update     # pull latest, rebuild backend, republish landing, restart
sudo ./deploy.sh status     # systemd state, /api/meta health, cert expiry, disk
sudo ./deploy.sh logs 100   # tail the backend journal
```

Override `REPO_URL` / `REPO_BRANCH` to deploy a fork or branch, or `DOMAIN`
for a different host. Secrets live only in `/etc/the-wall/secrets.env` on the
server (loaded via `THE_WALL_DEV_ENV_FILE`); the script generates a `JWT_SECRET`
on first run and refuses to start with the placeholder still in place. TLS is
optional — without certs it serves plain HTTP and prints the `certbot` command
to run, after which `deploy.sh nginx` switches the vhost to HTTPS.

---

## Project layout

```
.
├── src/                  Extension source (TypeScript, ~45 modules)
│   ├── index.ts            entry point
│   ├── ui-build.ts         builds the tabbed Win95 window
│   ├── ui-wire.ts          event wiring
│   ├── overlay.ts          placement, scaling, dots rendering
│   ├── data.ts             backend-backed profile/clan/template loaders
│   ├── backend.ts          API client
│   ├── dev-tools.ts        the dev-only __wallDev console API
│   └── …
├── extension/            manifest.json, background.js, bridge.js, icons/
├── backend/              Rust backend (Axum + SQLx)
│   ├── src/                main.rs (route table), routes/, auth, bots, gateway…
│   ├── migrations/         SQLx migrations (auto-run at boot)
│   └── example.env         config template (every key the backend reads)
├── landing/              static site (index, me, vai-auth, api-docs/, openapi.yaml)
├── spec/openapi.yaml     generated API spec (source of truth)
├── tests/
│   ├── extension/          bun assertion scripts
│   └── backend/            cargo integration tests
├── scripts/              gen-openapi.ts, test.ts
├── assets/badges/        the Win95 88×31 badges above
├── build.ts              multi-mode esbuild bundler
└── deploy.sh             git-based VPS deploy/update/status
```

`dist/`, `node_modules/`, `backend/target/`, and `secrets.env` are generated or
secret and stay out of git (see `.gitignore`).

---

## Security

- The extension never handles your filianislost.com password. It reads the
  site token already in your browser, exchanges it for a short-lived backend
  session, and never stores the site token.
- Account links use standard OAuth (Telegram OIDC, Discord OAuth2); the Discord
  interactions webhook verifies every request's Ed25519 signature.
- Backend secrets stay in `secrets.env` on the server — never baked into the
  binary or the extension bundle. Report anything sensitive to the address in
  [SECURITY.md](./SECURITY.md) rather than a public issue.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow.

---

MIT © VAI_PROG (Vadim) — see [LICENSE](./LICENSE).
