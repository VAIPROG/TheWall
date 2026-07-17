//! ADMIN command group — server vitals, logs, regions, and the two
//! security-sensitive mutations: `announce` (broadcast) and `moderate`
//! (global sanction). Both mutations are two-phase: a preview builds an
//! owner-scoped confirm button whose click re-dispatches with `sub=commit`.
use uuid::Uuid;

use crate::bots::core::callbacks::CallbackSpec;
use crate::bots::core::command::{ArgKind, ArgValue, Command, CommandArg, CommandCtx};
use crate::bots::core::permissions::Permission;
use crate::bots::core::response::{Action, ActionRow, Block, BotResponse, BtnStyle, Component};

/// Read a numeric arg tolerating the callback-store gotcha: slash commands
/// supply `ArgValue::Int`, but re-dispatched button clicks supply `ArgValue::Str`.
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

// ── status ──────────────────────────────────────────────────────────────────
pub struct Status;
#[async_trait::async_trait]
impl Command for Status {
    fn name(&self) -> &'static str { "status" }
    fn description(&self) -> &'static str { "Server vitals" }
    fn permission(&self) -> Permission { Permission::Admin }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let s = crate::bots::core::data::status_data(&ctx.state.pool).await;
        BotResponse::heading("📊 Status")
            .push(Block::Fields(vec![
                ("Users".into(), s.users.to_string()),
                ("Sessions".into(), s.sessions.to_string()),
                ("Templates".into(), s.templates.to_string()),
                ("Regions (enabled)".into(), s.regions_enabled.to_string()),
                ("Regions broken".into(), s.regions_broken.to_string()),
                (
                    "Last snapshot".into(),
                    s.last_snapshot.map(|t| t.to_rfc3339()).unwrap_or_else(|| "—".into()),
                ),
            ]))
            .ephemeral()
    }
}

// ── users ───────────────────────────────────────────────────────────────────
pub struct Users;
#[async_trait::async_trait]
impl Command for Users {
    fn name(&self) -> &'static str { "users" }
    fn description(&self) -> &'static str { "User & session counts" }
    fn permission(&self) -> Permission { Permission::Admin }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let u = crate::bots::core::data::user_count_data(&ctx.state.pool).await;
        BotResponse::heading("👥 Users")
            .push(Block::Fields(vec![
                ("Registered".into(), u.users.to_string()),
                ("Active today".into(), u.active_today.to_string()),
                ("Live sessions".into(), u.sessions.to_string()),
            ]))
            .ephemeral()
    }
}

// ── logs ────────────────────────────────────────────────────────────────────
pub struct Logs;
#[async_trait::async_trait]
impl Command for Logs {
    fn name(&self) -> &'static str { "logs" }
    fn description(&self) -> &'static str { "Recent alert events" }
    fn permission(&self) -> Permission { Permission::Admin }
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg {
            name: "n".into(),
            kind: ArgKind::Int,
            required: false,
            desc: "How many (1-50)".into(),
        }]
    }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let n = arg_i64(ctx, "n", 10).clamp(1, 50);
        let events = crate::bots::core::data::recent_events(&ctx.state.pool, n).await;
        if events.is_empty() {
            return BotResponse::text("No recent events.").ephemeral();
        }
        let rows: Vec<Vec<String>> = events
            .into_iter()
            .map(|e| vec![e.at.format("%m-%d %H:%M").to_string(), e.title])
            .collect();
        let mut resp = BotResponse::heading("🗒 Recent events").push(Block::Table {
            headers: vec!["When".into(), "Title".into()],
            rows,
        });
        if n < 50 {
            let id = ctx
                .state
                .callback_store
                .put(CallbackSpec {
                    command: "logs".into(),
                    sub: None,
                    args: vec![("n".into(), (n + 10).min(50).to_string())],
                    owner_external_id: ctx.principal.platform_id.clone(),
                })
                .await;
            resp = resp.row(ActionRow(vec![Component::Button {
                label: "Show more".into(),
                style: BtnStyle::Secondary,
                action: Action::Callback(id),
            }]));
        }
        resp.ephemeral()
    }
}

// ── regions ─────────────────────────────────────────────────────────────────
pub struct Regions;
#[async_trait::async_trait]
impl Command for Regions {
    fn name(&self) -> &'static str { "regions" }
    fn description(&self) -> &'static str { "Protected regions" }
    fn permission(&self) -> Permission { Permission::Admin }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let regions = crate::bots::core::data::regions_overview(&ctx.state.pool).await;
        if regions.is_empty() {
            return BotResponse::text("No regions configured.").ephemeral();
        }
        let rows: Vec<Vec<String>> = regions
            .iter()
            .map(|r| {
                vec![
                    r.name.clone(),
                    crate::bots::core::data::region_state_label(r).into(),
                    format!("{:.1}%", r.broken_pct),
                ]
            })
            .collect();
        BotResponse::heading("🛡 Regions")
            .push(Block::Table {
                headers: vec!["Region".into(), "State".into(), "Broken".into()],
                rows,
            })
            .ephemeral()
    }
}

// ── announce (broadcast, two-phase) ──────────────────────────────────────────
pub struct Announce;
#[async_trait::async_trait]
impl Command for Announce {
    fn name(&self) -> &'static str { "announce" }
    fn description(&self) -> &'static str { "Broadcast an announcement to all users" }
    fn permission(&self) -> Permission { Permission::Admin }
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg { name: "title".into(), kind: ArgKind::String, required: true, desc: "Title".into() },
            CommandArg { name: "body".into(), kind: ArgKind::String, required: true, desc: "Message body".into() },
        ]
    }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let title = arg_str(ctx, "title").unwrap_or("").trim();
        let body = arg_str(ctx, "body").unwrap_or("").trim();

        // Phase 2: commit.
        if ctx.sub.as_deref() == Some("commit") {
            if title.is_empty() || body.is_empty() {
                return BotResponse::text("Nothing to broadcast.").ephemeral();
            }
            let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM users")
                .fetch_all(&ctx.state.pool)
                .await
                .unwrap_or_default();
            let mut sent = 0usize;
            for id in ids {
                let ok = crate::routes::v3::notifications::notify(
                    &ctx.state.pool,
                    id,
                    "system_announcement",
                    title,
                    Some(body),
                    None,
                    serde_json::json!({ "viaBot": ctx.principal.platform_id }),
                )
                .await
                .is_ok();
                if ok {
                    sent += 1;
                }
            }
            return BotResponse::heading("✅ Broadcast sent")
                .push(Block::Text(format!("Delivered to {sent} users.")))
                .ephemeral();
        }

        // Phase 1: preview + owner-scoped confirm button.
        if title.is_empty() || body.is_empty() {
            return BotResponse::text("Usage: announce <title> <body>").ephemeral();
        }
        let id = ctx
            .state
            .callback_store
            .put(CallbackSpec {
                command: "announce".into(),
                sub: Some("commit".into()),
                args: vec![("title".into(), title.into()), ("body".into(), body.into())],
                owner_external_id: ctx.principal.platform_id.clone(),
            })
            .await;
        BotResponse::heading("📢 Confirm broadcast")
            .push(Block::Fields(vec![
                ("Title".into(), title.into()),
                ("Body".into(), body.into()),
            ]))
            .push(Block::Text("This sends a notification to EVERY user.".into()))
            .row(ActionRow(vec![Component::Button {
                label: "Send to everyone".into(),
                style: BtnStyle::Danger,
                action: Action::Callback(id),
            }]))
            .ephemeral()
    }
}

// ── moderate (global sanction, two-phase + extra privilege gate) ─────────────
pub struct Moderate;
#[async_trait::async_trait]
impl Command for Moderate {
    fn name(&self) -> &'static str { "moderate" }
    fn description(&self) -> &'static str { "Apply a global restriction to a user" }
    fn permission(&self) -> Permission { Permission::Admin }
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg { name: "user".into(), kind: ArgKind::String, required: true, desc: "Target username".into() },
            CommandArg { name: "action".into(), kind: ArgKind::String, required: true, desc: "ban | mute | restrict".into() },
            CommandArg { name: "reason".into(), kind: ArgKind::String, required: false, desc: "Reason".into() },
        ]
    }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        // EXTRA SECURITY GATE (both phases): bot-admin is NOT enough to sanction.
        // Require a linked Wall user whose global_role is moderator/admin/owner.
        let Some(uid) = ctx.principal.user_id else {
            return BotResponse::text("Sanctions require a linked Wall moderator account.").ephemeral();
        };
        let role: Option<String> = sqlx::query_scalar("SELECT global_role FROM users WHERE id = $1")
            .bind(uid)
            .fetch_optional(&ctx.state.pool)
            .await
            .ok()
            .flatten();
        let is_mod = matches!(role.as_deref(), Some("moderator") | Some("admin") | Some("owner"));
        if !is_mod {
            return BotResponse::text("You are not a Wall moderator.").ephemeral();
        }

        // Resolve target user by username.
        let target = arg_str(ctx, "user").unwrap_or("").trim().to_string();
        let tgt: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM users WHERE lower(username) = lower($1)")
                .bind(&target)
                .fetch_optional(&ctx.state.pool)
                .await
                .ok()
                .flatten();
        let Some(tgt_uuid) = tgt else {
            return BotResponse::text(format!("No user named `{target}`.")).ephemeral();
        };

        // Validate action.
        let action = arg_str(ctx, "action").unwrap_or("").to_lowercase();
        if !matches!(action.as_str(), "ban" | "mute" | "restrict") {
            return BotResponse::text("action must be ban|mute|restrict.").ephemeral();
        }

        // Phase 2: commit the global permanent restriction.
        if ctx.sub.as_deref() == Some("commit") {
            let (mute, ban, publish) = match action.as_str() {
                "ban" => (false, true, false),
                "mute" => (true, false, false),
                _ => (false, false, true),
            };
            let reason = arg_str(ctx, "reason").filter(|s| !s.is_empty());
            let res = sqlx::query(
                "INSERT INTO restrictions (id, user_id, scope, clan_id, applied_by, expires_at, reason, s_mute, s_ban, s_publish_templates, s_invite_to_clan, s_send_reports, s_send_modmail) \
                 VALUES (gen_random_uuid(), $1, 'global', NULL, $2, NULL, $3, $4, $5, $6, false, false, false)",
            )
            .bind(tgt_uuid)
            .bind(uid)
            .bind(reason)
            .bind(mute)
            .bind(ban)
            .bind(publish)
            .execute(&ctx.state.pool)
            .await;
            return match res {
                Ok(_) => BotResponse::heading("✅ Sanction applied")
                    .push(Block::Text(format!("`{action}` applied to `{target}`.")))
                    .ephemeral(),
                Err(_) => BotResponse::text("Failed to apply sanction.").ephemeral(),
            };
        }

        // Phase 1: preview + owner-scoped confirm button.
        let reason_raw = arg_str(ctx, "reason").unwrap_or("");
        let reason_display = if reason_raw.is_empty() { "—" } else { reason_raw };
        let id = ctx
            .state
            .callback_store
            .put(CallbackSpec {
                command: "moderate".into(),
                sub: Some("commit".into()),
                args: vec![
                    ("user".into(), target.clone()),
                    ("action".into(), action.clone()),
                    ("reason".into(), reason_raw.to_string()),
                ],
                owner_external_id: ctx.principal.platform_id.clone(),
            })
            .await;
        BotResponse::heading("⚖ Confirm sanction")
            .push(Block::Fields(vec![
                ("User".into(), target),
                ("Action".into(), action),
                ("Reason".into(), reason_display.into()),
            ]))
            .row(ActionRow(vec![Component::Button {
                label: "Apply sanction".into(),
                style: BtnStyle::Danger,
                action: Action::Callback(id),
            }]))
            .ephemeral()
    }
}
