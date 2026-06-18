# Security

## Reporting a vulnerability

Please don't open a public issue for security problems. Email
the-wall-dev@vai-rice.space with a description and, if you can, a proof of
concept. I'll confirm receipt and keep you posted on the fix.

## Notes for the curious

- The extension never handles your filianislost.com password. Login rides on
  the site token already in your browser; the backend exchanges it for a
  short-lived session and never stores it.
- Account links use standard OAuth (Telegram OIDC, Discord OAuth2). The
  Discord interactions webhook verifies every request's Ed25519 signature.
- Backend secrets live only in `secrets.env` on the server, loaded via
  `THE_WALL_DEV_ENV_FILE`. They are never baked into the binary or the
  extension bundle. If you fork this, keep your own `secrets.env` out of git.
