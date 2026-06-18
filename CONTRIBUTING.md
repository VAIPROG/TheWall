# Contributing

Thanks for taking a look. This started as a personal tool and grew, so the
bar for contributions is "does it work and stay out of the way" rather than
heavy process.

## Layout

- `src/` — the extension (TypeScript, bundled with esbuild via `build.ts`)
- `backend/` — the Rust API (axum + sqlx/Postgres)
- `landing/` — the static site at the-wall.vai-rice.space
- `tests/extension/` — `bun test`; `tests/backend/` — `cargo test`

## Building the extension

```sh
bun install
bun run build          # dev build into dist/
bun run typecheck      # tsc --noEmit
bun test tests/extension
```

`bun run publish` produces both the release and the max-compressed
("smallest") builds plus the userscript and per-browser zips.

## Running the backend

```sh
cp backend/example.env backend/.env   # fill in DATABASE_URL + JWT_SECRET
cd backend
cargo run
```

Migrations in `backend/migrations/` run automatically at boot. The optional
Telegram/Discord keys degrade gracefully — leave them blank and those
features just stay off (the boot log says which ones).

## A few conventions

- Keep the extension free of build-time network calls; everything talks to
  the backend at runtime.
- New API routes go under `/api/v2`; `/api/v1` is frozen for older clients.
- Run `bun run openapi` after changing the route table so the spec stays in
  sync.
- Don't commit `secrets.env` or anything under `dist/` — `.gitignore` already
  covers them, but double-check before opening a PR.

## Reporting bugs

Open an issue with the browser, extension version (Settings shows it), and
steps to reproduce. Screenshots of the overlay help a lot.
