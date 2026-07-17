//! TEMPLATE command group — read-only discovery of PUBLIC published templates:
//! `find` (name search), `preview` (embed the public WebP preview), and
//! `share` (hand back the shareable preview URL). All subcommands are
//! `Permission::Public`: they only ever surface public+published templates, so
//! the embedded preview URLs render anonymously (Discord/Telegram fetch them
//! server-side without a Bearer/session).
use crate::bots::core::command::{ArgKind, ArgValue, Command, CommandArg, CommandCtx};
use crate::bots::core::permissions::Permission;
use crate::bots::core::response::{Action, ActionRow, Block, BotResponse, BtnStyle, Component};

/// Read a numeric arg tolerating the callback-store gotcha (slash → Int,
/// re-dispatched button → Str). Unused here but kept for parity with clan.rs.
#[allow(dead_code)]
fn arg_i64(ctx: &CommandCtx<'_>, key: &str, default: i64) -> i64 {
    match ctx.arg(key) {
        Some(ArgValue::Int(i)) => *i,
        Some(ArgValue::Str(s)) => s.parse().unwrap_or(default),
        _ => default,
    }
}

fn arg_str<'a>(ctx: &'a CommandCtx<'a>, key: &str) -> Option<&'a str> {
    ctx.arg(key).and_then(|a| a.as_str())
}

/// Public preview URL for a template. Anonymous-accessible for public+published
/// templates, so it embeds/renders without auth in chat clients.
fn preview_url(id: uuid::Uuid) -> String {
    format!("https://the-wall.vai-rice.space/api/v3/templates/{id}/preview?size=256")
}

pub struct Template;
#[async_trait::async_trait]
impl Command for Template {
    fn name(&self) -> &'static str { "template" }
    fn description(&self) -> &'static str { "Find, preview, or share public templates" }
    fn permission(&self) -> Permission { Permission::Public }
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg {
                name: "find".into(),
                required: false,
                desc: "Search public templates by name".into(),
                kind: ArgKind::Sub(vec![CommandArg {
                    name: "q".into(),
                    kind: ArgKind::String,
                    required: true,
                    desc: "Search text".into(),
                }]),
            },
            CommandArg {
                name: "preview".into(),
                required: false,
                desc: "Show a template preview".into(),
                kind: ArgKind::Sub(vec![CommandArg {
                    name: "id".into(),
                    kind: ArgKind::String,
                    required: true,
                    desc: "Template id".into(),
                }]),
            },
            CommandArg {
                name: "share".into(),
                required: false,
                desc: "Get a shareable link".into(),
                kind: ArgKind::Sub(vec![CommandArg {
                    name: "id".into(),
                    kind: ArgKind::String,
                    required: true,
                    desc: "Template id".into(),
                }]),
            },
        ]
    }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let pool = &ctx.state.pool;
        match ctx.sub.as_deref() {
            // ── find: name search over public+published templates ────────────
            Some("find") => {
                let q = arg_str(ctx, "q").unwrap_or("").trim();
                if q.is_empty() {
                    return BotResponse::text("Usage: /template find <text>").ephemeral();
                }
                // Fuzzy (pg_trgm) search: exact-substring matches are boosted to
                // the top, then trigram similarity, then recency. `q` is bound
                // once as $1 — never interpolated into SQL. `%` operator and
                // similarity/word_similarity come from pg_trgm (migration 045).
                let rows = sqlx::query_as::<_, (uuid::Uuid, String, f32)>(
                    "SELECT id, name, GREATEST(similarity(name, $1), word_similarity($1, name)) AS sim \
                       FROM templates \
                      WHERE status='published' AND scope='public' \
                        AND (name ILIKE '%' || $1 || '%' OR name % $1 OR word_similarity($1, name) > 0.3) \
                      ORDER BY (name ILIKE '%' || $1 || '%') DESC, sim DESC, created_at DESC \
                      LIMIT 8",
                )
                .bind(q)
                .fetch_all(pool)
                .await
                .unwrap_or_default();
                if rows.is_empty() {
                    return BotResponse::text(format!(
                        "No public templates match \"{}\". Try a shorter or different word.",
                        q
                    ))
                    .ephemeral();
                }
                // Discord caps at 5 button-rows; show ≤5 and note any overflow.
                let total = rows.len();
                let shown = if total > 5 { &rows[..5] } else { &rows[..] };
                let mut resp = BotResponse::heading("🔎 Templates")
                    .push(Block::Text("Ближайшие совпадения — выбери превью:".into()));
                for (id, name, _sim) in shown {
                    resp = resp
                        .push(Block::Fields(vec![
                            ("Name".into(), name.clone()),
                            ("Id".into(), id.to_string()),
                        ]))
                        .row(ActionRow(vec![Component::Button {
                            label: "Preview".into(),
                            style: BtnStyle::Primary,
                            action: Action::Url(preview_url(*id)),
                        }]));
                }
                if total > 5 {
                    resp = resp.push(Block::Text(format!(
                        "…и ещё {} — уточни запрос.",
                        total - 5
                    )));
                }
                resp
            }
            // ── preview: embed the public WebP preview image ─────────────────
            Some("preview") => {
                let id_s = arg_str(ctx, "id").unwrap_or("").trim();
                let Some(id) = uuid::Uuid::parse_str(id_s).ok() else {
                    return BotResponse::text("Invalid template id.").ephemeral();
                };
                let ok: Option<(String,)> = sqlx::query_as(
                    "SELECT name FROM templates WHERE id=$1 AND status='published' AND scope='public'",
                )
                .bind(id)
                .fetch_optional(pool)
                .await
                .ok()
                .flatten();
                let Some((name,)) = ok else {
                    return BotResponse::text("No public template with that id.").ephemeral();
                };
                BotResponse::heading(format!("🖼 {name}")).push(Block::Image {
                    url: preview_url(id),
                    caption: Some(name),
                    spoiler: false,
                })
            }
            // ── share: per-wall WallDev + Charity share links ────────────────
            // Mirrors the extension's shareLink: {wallOrigin}/?the_wall_dev=
            // {urlencode({apiBase}/templates/{id}/wall-dev)}. The share link's
            // ORIGIN must be a WALL SITE (where the extension injects); the
            // encoded inner URL points at the backend (public_base_url).
            Some("share") => {
                let id_s = arg_str(ctx, "id").unwrap_or("").trim();
                let Some(id) = uuid::Uuid::parse_str(id_s).ok() else {
                    return BotResponse::text("Invalid template id.").ephemeral();
                };
                // Verify public+published; fetch name + document (for whitelist gating).
                let row: Option<(String, Option<serde_json::Value>)> = sqlx::query_as(
                    "SELECT name, document FROM templates WHERE id=$1 AND status='published' AND scope='public'",
                )
                .bind(id)
                .fetch_optional(pool)
                .await
                .ok()
                .flatten();
                let Some((name, document)) = row else {
                    return BotResponse::text("No public template with that id.").ephemeral();
                };

                // Backend base + the two inner (anonymously-openable) endpoints.
                let base = crate::routes::v3::templates::render::public_base_url(&ctx.state.config);
                let wall_dev_exp = format!("{base}/api/v3/templates/{id}/wall-dev");
                let charity_exp = format!("{base}/api/v3/templates/{id}/charity");

                // domainsWhitelist gating (mirror the extension's isAllowedOnDomain).
                let whitelist: Option<Vec<String>> = document.and_then(|d| {
                    d.get("domainsWhitelist")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_lowercase()))
                                .collect::<Vec<_>>()
                        })
                });

                // A wall host `h` matches domain `d` iff h == d || h.ends_with(".d")
                // after stripping a leading "*." from the whitelist domain.
                fn host_matches(host: &str, whitelist: &[String]) -> bool {
                    whitelist.iter().any(|d| {
                        let d = d.strip_prefix("*.").unwrap_or(d);
                        host == d || host.ends_with(&format!(".{d}"))
                    })
                }

                // Eligible walls: configured wall_sites gated by whitelist (if non-empty).
                let mut eligible: Vec<(String, String)> = Vec::new(); // (wall_origin, host)
                for wall in &ctx.state.config.wall_sites {
                    let Some(host) = url::Url::parse(wall)
                        .ok()
                        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
                    else {
                        continue;
                    };
                    let allowed = match &whitelist {
                        Some(wl) if !wl.is_empty() => host_matches(&host, wl),
                        _ => true,
                    };
                    if allowed {
                        eligible.push((wall.clone(), host));
                    }
                }

                if eligible.is_empty() {
                    return BotResponse::heading("🔗 Share")
                        .push(Block::Text(
                            "This template is restricted to domains outside the configured wall list."
                                .into(),
                        ))
                        .push(Block::Text(wall_dev_exp))
                        .ephemeral();
                }

                // Build a share URL, using url::Url for correct percent-encoding.
                fn share_url(wall: &str, param: &str, exp: &str) -> Option<String> {
                    let mut u = url::Url::parse(wall).ok()?;
                    u.query_pairs_mut().clear().append_pair(param, exp);
                    Some(u.to_string())
                }

                // Discord allows ≤5 rows; cap displayed walls at 5.
                let total = eligible.len();
                let capped = total > 5;
                let shown = if capped { &eligible[..5] } else { &eligible[..] };

                let mut resp = BotResponse::heading(format!("🔗 Share — {name}"))
                    .push(Block::Text("Открыть шаблон на стене:".into()));

                for (wall, host) in shown {
                    let mut buttons = Vec::new();
                    if let Some(u) = share_url(wall, "the_wall_dev", &wall_dev_exp) {
                        buttons.push(Component::Button {
                            label: format!("🧱 {host} · WallDev"),
                            style: BtnStyle::Primary,
                            action: Action::Url(u),
                        });
                    }
                    if let Some(u) = share_url(wall, "charity", &charity_exp) {
                        buttons.push(Component::Button {
                            label: format!("❤️ {host} · Charity"),
                            style: BtnStyle::Secondary,
                            action: Action::Url(u),
                        });
                    }
                    if !buttons.is_empty() {
                        resp = resp.row(ActionRow(buttons));
                    }
                }

                if capped {
                    resp = resp.push(Block::Text(format!("+{} more", total - 5)));
                }
                // Raw endpoint for copy-paste.
                resp.push(Block::Text(wall_dev_exp))
            }
            // ── bare /template: usage ────────────────────────────────────────
            _ => BotResponse::text(
                "Try: /template find <text>, /template preview <id>, /template share <id>",
            )
            .ephemeral(),
        }
    }
}
