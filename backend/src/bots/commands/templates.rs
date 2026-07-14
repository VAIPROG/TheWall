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
                // BIND the LIKE pattern — never interpolate user text into SQL.
                let pat = format!("%{}%", q);
                let rows = sqlx::query_as::<_, (uuid::Uuid, String, String)>(
                    "SELECT id, name, scope FROM templates \
                     WHERE status='published' AND scope='public' AND name ILIKE $1 \
                     ORDER BY created_at DESC LIMIT 5",
                )
                .bind(&pat)
                .fetch_all(pool)
                .await
                .unwrap_or_default();
                if rows.is_empty() {
                    return BotResponse::text(format!("No public templates match \"{}\".", q))
                        .ephemeral();
                }
                let mut resp = BotResponse::heading("🔎 Templates");
                for (id, name, _scope) in rows {
                    resp = resp
                        .push(Block::Fields(vec![
                            ("Name".into(), name),
                            ("Id".into(), id.to_string()),
                        ]))
                        .row(ActionRow(vec![Component::Button {
                            label: "Preview".into(),
                            style: BtnStyle::Primary,
                            action: Action::Url(preview_url(id)),
                        }]));
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
            // ── share: hand back the shareable preview URL ───────────────────
            Some("share") => {
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
                BotResponse::heading("🔗 Share")
                    .push(Block::Text(format!("Shareable link for \"{name}\":")))
                    .row(ActionRow(vec![Component::Button {
                        label: "Open preview".into(),
                        style: BtnStyle::Secondary,
                        action: Action::Url(preview_url(id)),
                    }]))
            }
            // ── bare /template: usage ────────────────────────────────────────
            _ => BotResponse::text(
                "Try: /template find <text>, /template preview <id>, /template share <id>",
            )
            .ephemeral(),
        }
    }
}
