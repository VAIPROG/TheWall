//! CLAN command group — the clan card, a paged roster, join-application
//! review (approve/deny via owner-scoped callback buttons), and clanchat
//! read/send. Clan-admin actions are gated IN-HANDLER (no ClanRole permission
//! level): a member may review applications only if their `clan_role` is
//! admin/moderator OR they own the clan. That gate sits at the TOP of
//! `Applications::handle`, so the approve/deny callback re-dispatch re-checks.
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

/// The user's first active clan: (clan_id, clan_role). Owner is inferred separately.
async fn user_clan(pool: &sqlx::PgPool, uid: Uuid) -> Option<(Uuid, String)> {
    sqlx::query_as::<_, (Uuid, String)>(
        "SELECT clan_id, clan_role FROM clan_memberships WHERE user_id=$1 AND active=TRUE ORDER BY joined_at ASC LIMIT 1",
    )
    .bind(uid)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

// ── clan (card) ──────────────────────────────────────────────────────────────
pub struct Clan;
#[async_trait::async_trait]
impl Command for Clan {
    fn name(&self) -> &'static str { "clan" }
    fn description(&self) -> &'static str { "Your clan card" }
    fn permission(&self) -> Permission { Permission::Linked }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let pool = &ctx.state.pool;
        let Some(uid) = ctx.principal.user_id else {
            return BotResponse::text("Link your Wall account first.").ephemeral();
        };
        let Some((cid, role)) = user_clan(pool, uid).await else {
            return BotResponse::text("You are not in a clan.").ephemeral();
        };
        let card = sqlx::query_as::<_, (String, Option<String>, bool, Option<Uuid>)>(
            "SELECT name, tag, owner_verified, owner_id FROM clans WHERE id=$1",
        )
        .bind(cid)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
        let members: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM clan_memberships WHERE clan_id=$1 AND active=TRUE")
                .bind(cid)
                .fetch_one(pool)
                .await
                .unwrap_or(0);
        let (name, tag, verified, owner_id) =
            card.unwrap_or_else(|| ("(unknown)".into(), None, false, None));
        let your_role = if owner_id == Some(uid) { "owner".to_string() } else { role };
        BotResponse::heading(format!("🏰 {name}"))
            .push(Block::Fields(vec![
                ("Tag".into(), tag.unwrap_or_else(|| "—".into())),
                ("Members".into(), members.to_string()),
                ("Your role".into(), your_role),
                ("Owner-verified".into(), if verified { "✅".into() } else { "—".into() }),
            ]))
            .ephemeral()
    }
}

// ── roster (paged) ───────────────────────────────────────────────────────────
pub struct Roster;
#[async_trait::async_trait]
impl Command for Roster {
    fn name(&self) -> &'static str { "roster" }
    fn description(&self) -> &'static str { "Clan member roster" }
    fn permission(&self) -> Permission { Permission::Linked }
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg { name: "page".into(), kind: ArgKind::Int, required: false, desc: "Page".into() }]
    }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let pool = &ctx.state.pool;
        let Some(uid) = ctx.principal.user_id else {
            return BotResponse::text("Link your Wall account first.").ephemeral();
        };
        let Some((cid, _role)) = user_clan(pool, uid).await else {
            return BotResponse::text("You are not in a clan.").ephemeral();
        };
        let page = arg_i64(ctx, "page", 1).max(1);
        let per: i64 = 15;
        let offset = (page - 1) * per;
        let rows = sqlx::query_as::<_, (String, String, chrono::DateTime<chrono::Utc>)>(
            "SELECT u.username, cm.clan_role, cm.joined_at FROM clan_memberships cm JOIN users u ON u.id=cm.user_id \
             WHERE cm.clan_id=$1 AND cm.active=TRUE ORDER BY cm.joined_at ASC LIMIT $2 OFFSET $3",
        )
        .bind(cid)
        .bind(per)
        .bind(offset)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        if rows.is_empty() {
            return BotResponse::text("No members on that page.").ephemeral();
        }
        let table_rows: Vec<Vec<String>> = rows
            .iter()
            .map(|(username, role, at)| {
                vec![username.clone(), role.clone(), at.format("%Y-%m-%d").to_string()]
            })
            .collect();
        let mut resp = BotResponse::heading(format!("📋 Roster (page {page})")).push(Block::Table {
            headers: vec!["Member".into(), "Role".into(), "Joined".into()],
            rows: table_rows,
        });
        let mut nav: Vec<Component> = Vec::new();
        if page > 1 {
            let id = ctx
                .state
                .callback_store
                .put(CallbackSpec {
                    command: "roster".into(),
                    sub: None,
                    args: vec![("page".into(), (page - 1).to_string())],
                    owner_external_id: ctx.principal.platform_id.clone(),
                })
                .await;
            nav.push(Component::Button {
                label: "◀ Prev".into(),
                style: BtnStyle::Secondary,
                action: Action::Callback(id),
            });
        }
        if rows.len() as i64 == per {
            let id = ctx
                .state
                .callback_store
                .put(CallbackSpec {
                    command: "roster".into(),
                    sub: None,
                    args: vec![("page".into(), (page + 1).to_string())],
                    owner_external_id: ctx.principal.platform_id.clone(),
                })
                .await;
            nav.push(Component::Button {
                label: "Next ▶".into(),
                style: BtnStyle::Secondary,
                action: Action::Callback(id),
            });
        }
        if !nav.is_empty() {
            resp = resp.row(ActionRow(nav));
        }
        resp.ephemeral()
    }
}

// ── applications (review, two-phase, clan-admin gated) ───────────────────────
pub struct Applications;

/// Whether `uid` may manage this clan's applications: clan_role ∈ {admin,
/// moderator} OR they are the clan owner.
async fn may_manage(pool: &sqlx::PgPool, cid: Uuid, uid: Uuid, role: &str) -> bool {
    if matches!(role, "admin" | "moderator") {
        return true;
    }
    let owner: Option<Uuid> = sqlx::query_scalar("SELECT owner_id FROM clans WHERE id=$1")
        .bind(cid)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    owner == Some(uid)
}

#[async_trait::async_trait]
impl Command for Applications {
    fn name(&self) -> &'static str { "applications" }
    fn description(&self) -> &'static str { "Review clan join requests" }
    fn permission(&self) -> Permission { Permission::Linked }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let pool = &ctx.state.pool;
        let Some(uid) = ctx.principal.user_id else {
            return BotResponse::text("Link your Wall account first.").ephemeral();
        };
        let Some((cid, role)) = user_clan(pool, uid).await else {
            return BotResponse::text("You are not in a clan.").ephemeral();
        };
        // Clan-admin gate at the TOP: re-checked on approve/deny re-dispatch.
        if !may_manage(pool, cid, uid, &role).await {
            return BotResponse::text("You are not a clan moderator.").ephemeral();
        }

        // ── Callback phase: approve ──
        if ctx.sub.as_deref() == Some("approve") {
            let Some(app_id) = arg_str(ctx, "app_id").and_then(|s| Uuid::parse_str(s).ok()) else {
                return BotResponse::text("Bad application id.").ephemeral();
            };
            // Verify the application belongs to THIS clan and is pending.
            let applicant: Option<Uuid> = sqlx::query_scalar(
                "SELECT applicant_id FROM clan_join_applications WHERE id=$1 AND clan_id=$2 AND status='pending'",
            )
            .bind(app_id)
            .bind(cid)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
            let Some(applicant_id) = applicant else {
                return BotResponse::text("Application not found or already handled.").ephemeral();
            };
            // Upsert membership (UNIQUE(user_id, clan_id) confirmed in migration 003).
            let ins = sqlx::query(
                "INSERT INTO clan_memberships (id, user_id, clan_id, clan_role, active, joined_at) \
                 VALUES (gen_random_uuid(), $1, $2, 'member', TRUE, NOW()) \
                 ON CONFLICT (user_id, clan_id) DO UPDATE SET active=TRUE, clan_role='member'",
            )
            .bind(applicant_id)
            .bind(cid)
            .execute(pool)
            .await;
            if ins.is_err() {
                return BotResponse::text("Failed to add member.").ephemeral();
            }
            let _ = sqlx::query(
                "UPDATE clan_join_applications SET status='approved', reviewed_by=$1, reviewed_at=NOW() WHERE id=$2",
            )
            .bind(uid)
            .bind(app_id)
            .execute(pool)
            .await;
            return BotResponse::heading("✅ Approved")
                .push(Block::Text("Applicant added to the clan.".into()))
                .ephemeral();
        }

        // ── Callback phase: deny ──
        if ctx.sub.as_deref() == Some("deny") {
            let Some(app_id) = arg_str(ctx, "app_id").and_then(|s| Uuid::parse_str(s).ok()) else {
                return BotResponse::text("Bad application id.").ephemeral();
            };
            let res = sqlx::query(
                "UPDATE clan_join_applications SET status='rejected', reviewed_by=$1, reviewed_at=NOW() \
                 WHERE id=$2 AND clan_id=$3 AND status='pending'",
            )
            .bind(uid)
            .bind(app_id)
            .bind(cid)
            .execute(pool)
            .await;
            return match res {
                Ok(r) if r.rows_affected() > 0 => {
                    BotResponse::heading("🚫 Denied").push(Block::Text("Application rejected.".into())).ephemeral()
                }
                Ok(_) => BotResponse::text("Application not found or already handled.").ephemeral(),
                Err(_) => BotResponse::text("Failed to deny application.").ephemeral(),
            };
        }

        // ── List phase ──
        let apps = sqlx::query_as::<_, (Uuid, String, String)>(
            "SELECT a.id, u.username, COALESCE(a.message,'') FROM clan_join_applications a \
             JOIN users u ON u.id=a.applicant_id \
             WHERE a.clan_id=$1 AND a.status='pending' ORDER BY a.created_at ASC LIMIT 10",
        )
        .bind(cid)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        if apps.is_empty() {
            return BotResponse::text("No pending applications.").ephemeral();
        }
        let mut resp = BotResponse::heading("📨 Pending applications");
        for (app_id, username, message) in apps {
            let msg = if message.trim().is_empty() { "—".to_string() } else { message };
            resp = resp.push(Block::Fields(vec![
                ("Applicant".into(), username),
                ("Message".into(), msg),
            ]));
            let approve_id = ctx
                .state
                .callback_store
                .put(CallbackSpec {
                    command: "applications".into(),
                    sub: Some("approve".into()),
                    args: vec![("app_id".into(), app_id.to_string())],
                    owner_external_id: ctx.principal.platform_id.clone(),
                })
                .await;
            let deny_id = ctx
                .state
                .callback_store
                .put(CallbackSpec {
                    command: "applications".into(),
                    sub: Some("deny".into()),
                    args: vec![("app_id".into(), app_id.to_string())],
                    owner_external_id: ctx.principal.platform_id.clone(),
                })
                .await;
            resp = resp.row(ActionRow(vec![
                Component::Button {
                    label: "Approve".into(),
                    style: BtnStyle::Success,
                    action: Action::Callback(approve_id),
                },
                Component::Button {
                    label: "Deny".into(),
                    style: BtnStyle::Danger,
                    action: Action::Callback(deny_id),
                },
            ]));
        }
        resp.ephemeral()
    }
}

// ── clanchat (read / send) ───────────────────────────────────────────────────
pub struct Clanchat;
#[async_trait::async_trait]
impl Command for Clanchat {
    fn name(&self) -> &'static str { "clanchat" }
    fn description(&self) -> &'static str { "Read or post in your clan chat" }
    fn permission(&self) -> Permission { Permission::Linked }
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg {
                name: "read".into(),
                required: false,
                desc: "Show recent clan chat".into(),
                kind: ArgKind::Sub(vec![CommandArg {
                    name: "n".into(),
                    kind: ArgKind::Int,
                    required: false,
                    desc: "How many (1-25)".into(),
                }]),
            },
            CommandArg {
                name: "send".into(),
                required: false,
                desc: "Post to your clan chat".into(),
                kind: ArgKind::Sub(vec![CommandArg {
                    name: "text".into(),
                    kind: ArgKind::String,
                    required: true,
                    desc: "Message text".into(),
                }]),
            },
        ]
    }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let pool = &ctx.state.pool;
        let Some(uid) = ctx.principal.user_id else {
            return BotResponse::text("Link your Wall account first.").ephemeral();
        };
        match ctx.sub.as_deref() {
            Some("send") => {
                let text = arg_str(ctx, "text").unwrap_or("").trim();
                let username = ctx.principal.username.as_deref().unwrap_or("bot-user");
                match crate::bots::core::data::clan_send_message(pool, uid, username, text).await {
                    Ok(()) => BotResponse::heading("📨 Sent").ephemeral(),
                    Err(e) => BotResponse::text(format!("⛔ {e}")).ephemeral(),
                }
            }
            // read is the default (both Some("read") and no sub).
            _ => {
                let n = arg_i64(ctx, "n", 10).clamp(1, 25);
                match crate::bots::core::data::clan_recent_messages(pool, uid, n).await {
                    Ok(msgs) if msgs.is_empty() => BotResponse::text("No messages yet.").ephemeral(),
                    Ok(msgs) => {
                        let mut resp = BotResponse::heading("💬 Clan chat");
                        for m in msgs {
                            resp = resp.push(Block::Quote(format!("{}: {}", m.author, m.text)));
                        }
                        resp.ephemeral()
                    }
                    Err(e) => BotResponse::text(format!("⛔ {e}")).ephemeral(),
                }
            }
        }
    }
}
