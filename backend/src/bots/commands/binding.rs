//! BINDING command group — bind / unbind a Telegram group or Discord guild to a
//! clan. This is a TRUST BOUNDARY (mirrors the v6.2.8 OAuth guild-verify): a bind
//! requires BOTH (1) LIVE proof the invoker controls the group/guild — checked
//! against the platform API, never trusted from client input — AND (2) that the
//! invoker is an admin/owner of the target clan.
//!
//! The group/guild id is `ctx.chat.id` (platform-delivered) and the user id is
//! `ctx.principal.platform_id` (platform-verified). The clan is a user-supplied
//! ARG, so it is authorization-checked against the invoker's clan membership —
//! never blindly bound. All checks FAIL CLOSED: any API error or mismatch refuses.
//!
//! Ownership flip: only the actual group/guild OWNER (Telegram `creator` /
//! Discord guild owner) flips a currently-unverified clan to owner_verified. A
//! mere `administrator` binds but does not earn ownership.
use uuid::Uuid;

use crate::bots::core::command::{ArgKind, Command, CommandArg, CommandCtx, Platform};
use crate::bots::core::permissions::Permission;
use crate::bots::core::response::{Block, BotResponse};

fn arg_str<'a>(ctx: &'a CommandCtx<'a>, key: &str) -> Option<&'a str> {
    ctx.arg(key).and_then(|a| a.as_str())
}

/// Whether `uid` may administer `cid`: clan_role ∈ {admin, moderator} on an
/// active membership, OR they are the clan owner. Same gate as clan.rs.
async fn may_admin_clan(pool: &sqlx::PgPool, cid: Uuid, uid: Uuid, owner_id: Option<Uuid>) -> bool {
    if owner_id == Some(uid) {
        return true;
    }
    let role: Option<String> = sqlx::query_scalar(
        "SELECT clan_role FROM clan_memberships WHERE user_id=$1 AND clan_id=$2 AND active=TRUE",
    )
    .bind(uid)
    .bind(cid)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    matches!(role.as_deref(), Some("admin") | Some("moderator"))
}

/// The binding-scope id: the id a binding key is stored under and (on Discord)
/// the id the live ownership probe targets.
///
/// - **Telegram:** the group chat id (`ctx.chat.id`) — correct for both
///   `getChatMember` and the binding key.
/// - **Discord:** the GUILD id (`ctx.chat.guild_id`), NOT `ctx.chat.id` (which is
///   the channel id). `None` in a DM / outside a guild, so the caller refuses.
fn scope_id(ctx: &CommandCtx<'_>) -> Option<String> {
    match ctx.chat.platform {
        Platform::Telegram => Some(ctx.chat.id.clone()),
        Platform::Discord => ctx.chat.guild_id.clone(),
    }
}

/// LIVE ownership probe against the platform API. Returns `Some(is_owner)` when
/// the invoker is at least an admin of the chat (`is_owner` = they are the actual
/// group/guild OWNER); `None` when they are NOT an admin, the bot isn't a member,
/// the token is missing, or the API errors — i.e. every ambiguous case fails
/// closed and the caller must refuse the bind.
///
/// Per-platform id: Telegram uses `ctx.chat.id` (the group id) for
/// `getChatMember`; Discord uses the GUILD id (`ctx.chat.guild_id`) for
/// `GET /guilds/{id}` — the channel id would always 404.
async fn live_chat_owner_check(ctx: &CommandCtx<'_>) -> Option<bool> {
    let user_id = ctx.principal.platform_id.as_str();
    let client = reqwest::Client::new();
    match ctx.chat.platform {
        Platform::Telegram => {
            let chat_id = ctx.chat.id.as_str();
            let token = ctx.state.config.oauth.telegram_bot_token.as_deref()?;
            let url = format!(
                "https://api.telegram.org/bot{token}/getChatMember?chat_id={chat_id}&user_id={user_id}"
            );
            let resp = match client.get(&url).send().await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!("bots::binding: telegram getChatMember error: {e}");
                    return None;
                }
            };
            let v: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!("bots::binding: telegram getChatMember decode: {e}");
                    return None;
                }
            };
            match v.pointer("/result/status").and_then(|s| s.as_str()) {
                Some("creator") => Some(true),
                Some("administrator") => Some(false),
                _ => None,
            }
        }
        Platform::Discord => {
            // Discord probes the GUILD, not the channel. No guild id (DM) →
            // fail closed.
            let guild_id = ctx.chat.guild_id.as_deref()?;
            let token = ctx.state.config.oauth.discord_bot_token.as_deref()?;
            let url = format!("https://discord.com/api/v10/guilds/{guild_id}");
            let resp = match client
                .get(&url)
                .header("Authorization", format!("Bot {token}"))
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!("bots::binding: discord get-guild error: {e}");
                    return None;
                }
            };
            if !resp.status().is_success() {
                tracing::warn!("bots::binding: discord get-guild {}", resp.status());
                return None;
            }
            let v: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!("bots::binding: discord get-guild decode: {e}");
                    return None;
                }
            };
            match v.get("owner_id").and_then(|o| o.as_str()) {
                Some(owner) if owner == user_id => Some(true),
                _ => None,
            }
        }
    }
}

/// Platform-specific "you're not an admin here" refusal.
fn not_chat_admin(platform: Platform) -> BotResponse {
    let msg = match platform {
        Platform::Telegram => {
            "You must be an admin of this Telegram group (and the bot must be a member)."
        }
        Platform::Discord => {
            "You must be the owner of this Discord server (and the bot must be in it)."
        }
    };
    BotResponse::text(msg).ephemeral()
}

// ── bind-clan ────────────────────────────────────────────────────────────────
pub struct BindClan;
#[async_trait::async_trait]
impl Command for BindClan {
    fn name(&self) -> &'static str { "bind-clan" }
    fn description(&self) -> &'static str { "Bind this group/guild to your clan" }
    fn permission(&self) -> Permission { Permission::Linked }
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg {
            name: "clan".into(),
            kind: ArgKind::String,
            required: true,
            desc: "Clan id or tag".into(),
        }]
    }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let pool = &ctx.state.pool;
        if !ctx.chat.is_group {
            return BotResponse::text("Run this inside your group/guild.").ephemeral();
        }
        // Binding-scope id (Discord guild id / Telegram chat id). None on Discord
        // means no guild (DM) — the guild probe needs it, so refuse explicitly.
        let Some(scope) = scope_id(ctx) else {
            return BotResponse::text("Run this inside a Discord server.").ephemeral();
        };
        let Some(uid) = ctx.principal.user_id else {
            return BotResponse::text("Link your Wall account first.").ephemeral();
        };

        // 2. Resolve the target clan from the arg (uuid OR tag).
        let raw = arg_str(ctx, "clan").unwrap_or("").trim();
        let clan = if let Ok(id) = Uuid::parse_str(raw) {
            sqlx::query_as::<_, (Uuid, Option<Uuid>, bool)>(
                "SELECT id, owner_id, owner_verified FROM clans WHERE id=$1",
            )
            .bind(id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
        } else {
            sqlx::query_as::<_, (Uuid, Option<Uuid>, bool)>(
                "SELECT id, owner_id, owner_verified FROM clans WHERE lower(tag)=lower($1)",
            )
            .bind(raw)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
        };
        let Some((clan_id, owner_id, owner_verified)) = clan else {
            return BotResponse::text("No clan with that id/tag.").ephemeral();
        };

        // 3. Clan-admin authorization (the user-supplied arg is checked here —
        //    never bind a clan the invoker doesn't administer).
        if !may_admin_clan(pool, clan_id, uid, owner_id).await {
            return BotResponse::text("You must be an admin of that clan.").ephemeral();
        }

        // 4. LIVE platform ownership check — Telegram: chat.id via getChatMember;
        //    Discord: guild_id via GET /guilds/{id}. Fails closed.
        let Some(is_chat_owner) = live_chat_owner_check(ctx).await else {
            return not_chat_admin(ctx.chat.platform);
        };

        // 5. Insert the binding, idempotent on UNIQUE(platform, chat_id).
        let ins = sqlx::query(
            "INSERT INTO clan_bindings (id, clan_id, platform, chat_id, verified_by, verified_at) \
             VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW()) \
             ON CONFLICT (platform, chat_id) DO UPDATE SET clan_id=EXCLUDED.clan_id, \
             verified_by=EXCLUDED.verified_by, verified_at=NOW()",
        )
        .bind(clan_id)
        .bind(ctx.chat.platform.as_str())
        .bind(scope.as_str())
        .bind(uid)
        .execute(pool)
        .await;
        if ins.is_err() {
            return BotResponse::text("Failed to bind the clan.").ephemeral();
        }

        // 6. Ownership flip — ONLY for the actual group/guild OWNER and ONLY when
        //    the clan is currently owner-unverified.
        let mut flipped = false;
        if is_chat_owner && !owner_verified {
            let via = match ctx.chat.platform {
                Platform::Telegram => "telegram",
                Platform::Discord => "discord-bot",
            };
            let res = sqlx::query(
                "UPDATE clans SET owner_verified=TRUE, owner_verified_via=$1, owner_verified_at=NOW() \
                 WHERE id=$2 AND owner_verified=FALSE",
            )
            .bind(via)
            .bind(clan_id)
            .execute(pool)
            .await;
            flipped = matches!(res, Ok(r) if r.rows_affected() > 0);
        }

        let clan_label = if raw.is_empty() {
            clan_id.to_string()
        } else {
            raw.to_string()
        };
        BotResponse::heading("🔗 Clan bound")
            .push(Block::Fields(vec![
                ("Clan".into(), clan_label),
                ("Chat".into(), scope.clone()),
                (
                    "Ownership verified".into(),
                    if flipped { "✅ now verified".into() } else { "— (binding only)".into() },
                ),
            ]))
            .ephemeral()
    }
}

// ── unbind-clan ──────────────────────────────────────────────────────────────
pub struct UnbindClan;
#[async_trait::async_trait]
impl Command for UnbindClan {
    fn name(&self) -> &'static str { "unbind-clan" }
    fn description(&self) -> &'static str { "Unbind this group/guild from its clan" }
    fn permission(&self) -> Permission { Permission::Linked }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let pool = &ctx.state.pool;
        if !ctx.chat.is_group {
            return BotResponse::text("Run this inside your group/guild.").ephemeral();
        }
        // Same binding-scope id used at bind time (Discord guild id / Telegram
        // chat id) so unbind matches exactly what bind stored.
        let Some(scope) = scope_id(ctx) else {
            return BotResponse::text("Run this inside a Discord server.").ephemeral();
        };
        let Some(uid) = ctx.principal.user_id else {
            return BotResponse::text("Link your Wall account first.").ephemeral();
        };

        // 2. Look up the binding for this chat.
        let platform = ctx.chat.platform.as_str();
        let bound: Option<(Uuid,)> = sqlx::query_as::<_, (Uuid,)>(
            "SELECT clan_id FROM clan_bindings WHERE platform=$1 AND chat_id=$2",
        )
        .bind(platform)
        .bind(scope.as_str())
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
        let Some((clan_id,)) = bound else {
            return BotResponse::text("This chat isn't bound to a clan.").ephemeral();
        };

        // 3. Clan-admin authorization on the bound clan.
        let owner_id: Option<Uuid> = sqlx::query_scalar("SELECT owner_id FROM clans WHERE id=$1")
            .bind(clan_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
        if !may_admin_clan(pool, clan_id, uid, owner_id).await {
            return BotResponse::text("You must be an admin of the bound clan.").ephemeral();
        }

        // 4. Delete the binding. Ownership stays verified once earned.
        let res = sqlx::query("DELETE FROM clan_bindings WHERE platform=$1 AND chat_id=$2")
            .bind(platform)
            .bind(scope.as_str())
            .execute(pool)
            .await;
        match res {
            Ok(_) => BotResponse::heading("🔓 Unbound")
                .push(Block::Text("This chat is no longer bound to a clan.".into()))
                .ephemeral(),
            Err(_) => BotResponse::text("Failed to unbind.").ephemeral(),
        }
    }
}
