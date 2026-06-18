//! Discord admin commands via the interactions webhook.
//!
//! Discord has no polling API for commands — the application registers global
//! slash commands at boot and Discord POSTs interactions to
//! `/api/v2/discord/interactions`, signed with the application's Ed25519 key.
//! We verify the signature (mandatory — Discord probes with bad signatures
//! and disables endpoints that accept them), answer PINGs, and serve the same
//! admin command set as the Telegram bot, formatted as markdown. Replies are
//! ephemeral so command output never lingers in channels.
//!
//! Authorisation matches Telegram: the invoking user id must be in the
//! bot_admins registry ('discord' platform, seeded from DISCORD_ADMIN_IDS).
//! Strangers get a quiet ephemeral brush-off (the webhook MUST respond, so
//! full silence isn't an option here).

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{Value, json};

use crate::bot_core;
use crate::{AppState, OAuthConfig};

/* ----------------------------- registration ------------------------------ */

/// Register the global slash-command set at boot. Fire-and-forget: a failure
/// only logs — the webhook still answers whatever commands already exist.
pub fn register_commands(oauth: OAuthConfig) {
    let (Some(app_id), Some(bot_token)) = (
        oauth.discord_application_id.clone(),
        oauth.discord_bot_token.clone(),
    ) else {
        tracing::info!("discord_commands: app id / bot token missing — slash registration skipped");
        return;
    };
    tokio::spawn(async move {
        let commands = json!([
            // -- admin set (bot_admins registry) --------------------------------
            { "name": "help",       "description": "List available commands", "type": 1 },
            { "name": "status",     "description": "Server vitals: users, templates, last snapshot", "type": 1 },
            { "name": "user_count", "description": "Registered users + active sessions", "type": 1 },
            { "name": "snapshot",   "description": "Latest wall snapshot links", "type": 1 },
            { "name": "logs",       "description": "Recent events (alerts)", "type": 1,
              "options": [{ "name": "n", "description": "How many (1-50)", "type": 4, "required": false }] },
            { "name": "regions",    "description": "Protected regions and their status", "type": 1 },
            // -- linked-user set (any Wall account with Discord linked) ---------
            { "name": "me",         "description": "Your Wall profile (linked accounts only)", "type": 1 },
            { "name": "clan-chat",  "description": "Read or post in your clan chat", "type": 1,
              "options": [
                { "name": "read", "description": "Show recent clan chat messages", "type": 1,
                  "options": [{ "name": "n", "description": "How many (1-25)", "type": 4, "required": false }] },
                { "name": "send", "description": "Send a message to your clan chat", "type": 1,
                  "options": [{ "name": "text", "description": "Message text", "type": 3, "required": true }] }
              ] },
        ]);
        let url = format!("https://discord.com/api/v10/applications/{app_id}/commands");
        match reqwest::Client::new()
            .put(&url)
            .header("Authorization", format!("Bot {bot_token}"))
            .json(&commands)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                tracing::info!("discord_commands: slash commands registered");
            }
            Ok(r) => tracing::warn!(
                "discord_commands: registration {}: {}",
                r.status(),
                r.text().await.unwrap_or_default()
            ),
            Err(e) => tracing::warn!("discord_commands: registration failed: {e}"),
        }
    });
}

/* ------------------------------ verification ----------------------------- */

fn verify_signature(public_key_hex: &str, headers: &HeaderMap, body: &[u8]) -> bool {
    let Some(sig_hex) = headers.get("x-signature-ed25519").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(timestamp) = headers.get("x-signature-timestamp").and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let (Ok(key_bytes), Ok(sig_bytes)) = (hex::decode(public_key_hex), hex::decode(sig_hex))
    else {
        return false;
    };
    let Ok(key_arr): Result<[u8; 32], _> = key_bytes.try_into() else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key_arr) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else {
        return false;
    };
    let mut message = Vec::with_capacity(timestamp.len() + body.len());
    message.extend_from_slice(timestamp.as_bytes());
    message.extend_from_slice(body);
    key.verify(&message, &sig).is_ok()
}

/* -------------------------------- handler -------------------------------- */

pub(crate) const EPHEMERAL: u64 = 1 << 6;
/// Discord caps message content at 2000 chars; leave headroom.
const MAX_CONTENT: usize = 1900;

fn clip(mut s: String) -> String {
    if s.len() > MAX_CONTENT {
        // Truncate on a char boundary, then mark it.
        let mut end = MAX_CONTENT;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push_str("\n…(truncated)");
    }
    s
}

/// POST /api/v2/discord/interactions
///
/// Flow: verify signature → PONG for pings → for commands, immediately
/// return a DEFERRED ephemeral ack (type 5) and finish the real answer in a
/// spawned task that PATCHes the original response. Discord cuts the cord at
/// 3 seconds — deferring makes DB latency irrelevant and every stage logs,
/// so a silent "Приложение не отвечает" can be traced from the server side.
pub async fn interactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(pubkey) = state.oauth.discord_public_key.as_deref() else {
        tracing::warn!("discord interactions hit but DISCORD_PUBLIC_KEY not set");
        return (StatusCode::SERVICE_UNAVAILABLE, "interactions not configured").into_response();
    };
    if !verify_signature(pubkey, &headers, &body) {
        tracing::warn!("discord interactions: signature verification FAILED");
        return (StatusCode::UNAUTHORIZED, "invalid request signature").into_response();
    }
    let Ok(v) = serde_json::from_slice::<Value>(&body) else {
        tracing::warn!("discord interactions: unparseable body");
        return (StatusCode::BAD_REQUEST, "bad json").into_response();
    };

    match v.get("type").and_then(|t| t.as_u64()) {
        // PING → PONG (Discord's endpoint validation).
        Some(1) => {
            tracing::info!("discord interactions: PING ok");
            axum::Json(json!({ "type": 1 })).into_response()
        }
        // APPLICATION_COMMAND → defer, then follow up.
        Some(2) => {
            spawn_followup(state, v);
            axum::Json(json!({ "type": 5, "data": { "flags": EPHEMERAL } })).into_response()
        }
        other => {
            tracing::warn!("discord interactions: unsupported type {other:?}");
            (StatusCode::BAD_REQUEST, "unsupported interaction").into_response()
        }
    }
}

/// Run the command in the background and PATCH the deferred original
/// response. Shared by the webhook handler above (which acks with an HTTP
/// type-5 body) and the gateway client (which acks via the callback REST
/// endpoint) — both must have deferred BEFORE calling this.
pub(crate) fn spawn_followup(state: AppState, v: Value) {
    let name = v
        .pointer("/data/name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    let token = v
        .pointer("/token")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let app_id = state
        .oauth
        .discord_application_id
        .clone()
        .or_else(|| {
            v.pointer("/application_id")
                .and_then(|a| a.as_str())
                .map(String::from)
        })
        .unwrap_or_default();
    tracing::info!("discord interactions: command /{name}");
    tokio::spawn(async move {
        let content = clip(run_command(&state, &v, &name).await);
        let url =
            format!("https://discord.com/api/v10/webhooks/{app_id}/{token}/messages/@original");
        match reqwest::Client::new()
            .patch(&url)
            .json(&json!({ "content": content }))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                tracing::info!("discord /{name}: followup delivered");
            }
            Ok(r) => tracing::warn!(
                "discord /{name}: followup {}: {}",
                r.status(),
                r.text().await.unwrap_or_default()
            ),
            Err(e) => tracing::warn!("discord /{name}: followup error: {e}"),
        }
    });
}

/// Dispatch a slash command. Admin commands need the bot_admins registry;
/// /me and /clan-chat work for ANY Wall account with Discord linked.
async fn run_command(state: &AppState, v: &Value, name: &str) -> String {
    // Guild interactions carry member.user, DMs carry user.
    let discord_id = v
        .pointer("/member/user/id")
        .or_else(|| v.pointer("/user/id"))
        .and_then(|i| i.as_str())
        .unwrap_or_default()
        .to_string();
    if discord_id.is_empty() {
        return "⛔ Could not identify you.".into();
    }

    // Linked-user commands first.
    match name {
        "me" => {
            let Some((uid, _)) = bot_core::find_user_by_platform(&state.pool, "discord", &discord_id).await
            else {
                return "⛔ No Wall account is linked to this Discord. Link it from the extension (Settings → Linked accounts).".into();
            };
            return me_md(state, uid).await;
        }
        "clan-chat" => {
            let Some((uid, username)) =
                bot_core::find_user_by_platform(&state.pool, "discord", &discord_id).await
            else {
                return "⛔ No Wall account is linked to this Discord. Link it from the extension (Settings → Linked accounts).".into();
            };
            // Subcommand: options[0] = {name: read|send, options: [...]}
            let sub = v.pointer("/data/options/0");
            let sub_name = sub.and_then(|s| s.get("name")).and_then(|n| n.as_str()).unwrap_or("read");
            match sub_name {
                "send" => {
                    let text = sub
                        .and_then(|s| s.pointer("/options/0/value"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    return match bot_core::clan_send_message(&state.pool, uid, &username, text).await {
                        Ok(()) => "📨 Sent to your clan chat.".into(),
                        Err(e) => format!("⛔ {e}"),
                    };
                }
                _ => {
                    let n = sub
                        .and_then(|s| s.pointer("/options/0/value"))
                        .and_then(|x| x.as_i64())
                        .unwrap_or(10);
                    return clan_chat_md(state, uid, n).await;
                }
            }
        }
        _ => {}
    }

    // Admin set.
    if !bot_core::is_bot_admin(&state.pool, "discord", &discord_id).await {
        return "⛔ Not authorised.".into();
    }
    let n_opt = v
        .pointer("/data/options")
        .and_then(|o| o.as_array())
        .and_then(|a| a.first())
        .and_then(|o| o.get("value"))
        .and_then(|x| x.as_i64())
        .unwrap_or(10);
    match name {
        "help" => help_md(),
        "status" => status_md(state).await,
        "user_count" => user_count_md(state).await,
        "snapshot" => snapshot_md(state).await,
        "logs" => logs_md(state, n_opt).await,
        "regions" => regions_md(state).await,
        other => format!("Unknown command `{other}`.\n{}", help_md()),
    }
}

async fn me_md(state: &AppState, uid: uuid::Uuid) -> String {
    let Some(d) = bot_core::me_data(&state.pool, uid).await else {
        return "⛔ Profile not found.".into();
    };
    format!(
        "**👤 {}** ({})\nClan: **{}**{}\nPixels placed: **{}**\nLinks: {} Telegram · {} Discord",
        d.username,
        d.global_role,
        d.clan_name.as_deref().unwrap_or("—"),
        d.clan_role.map(|r| format!(" · {r}")).unwrap_or_default(),
        d.pixels_placed,
        if d.telegram_linked { "✅" } else { "—" },
        if d.discord_linked { "✅" } else { "—" },
    )
}

async fn clan_chat_md(state: &AppState, uid: uuid::Uuid, n: i64) -> String {
    match bot_core::clan_recent_messages(&state.pool, uid, n).await {
        Err(e) => format!("⛔ {e}"),
        Ok(rows) if rows.is_empty() => "Clan chat is empty.".into(),
        Ok(rows) => {
            let mut out = format!("**💬 Last {} clan messages**\n", rows.len());
            for m in rows {
                out += &format!(
                    "<t:{}:t> **{}**: {}\n",
                    m.at.timestamp(),
                    m.author,
                    m.text.get(..200).unwrap_or(&m.text)
                );
            }
            out
        }
    }
}

/* ------------------------------ formatters ------------------------------- */

fn help_md() -> String {
    "**🧱 The Wall Dev — bot**\n\
     __For every linked account:__\n\
     `/me` — your Wall profile\n\
     `/clan-chat read [n]` — recent clan messages\n\
     `/clan-chat send <text>` — post to your clan chat\n\
     __Admin only:__\n\
     `/status` — server vitals\n\
     `/user_count` — users + live sessions\n\
     `/snapshot` — latest wall snapshot links\n\
     `/logs [n]` — recent events\n\
     `/regions` — protected regions and their status"
        .to_string()
}

async fn status_md(state: &AppState) -> String {
    let d = bot_core::status_data(&state.pool).await;
    let snap = d
        .last_snapshot
        .map(|t| format!("<t:{}:R>", t.timestamp()))
        .unwrap_or_else(|| "never".into());
    format!(
        "**📟 Status**\nUsers: **{}** · Sessions: **{}** · Templates: **{}**\nProtected regions: **{}** ({} 🔴)\nLast snapshot: {}",
        d.users, d.sessions, d.templates, d.regions_enabled, d.regions_broken, snap
    )
}

async fn user_count_md(state: &AppState) -> String {
    let d = bot_core::user_count_data(&state.pool).await;
    format!(
        "**{}** users · **{}** active today · **{}** live sessions",
        d.users, d.active_today, d.sessions
    )
}

async fn snapshot_md(state: &AppState) -> String {
    let links = bot_core::latest_snapshot(&state.pool).await;
    if links.is_empty() {
        return "No snapshots stored yet.".into();
    }
    let mut out = format!("**📸 Latest snapshot** (<t:{}:R>)\n", links[0].at.timestamp());
    for l in links {
        match l.url {
            Some(url) if !url.is_empty() => out += &format!("• [{}]({})\n", l.size, url),
            _ => out += &format!("• {} — (no url)\n", l.size),
        }
    }
    out
}

async fn logs_md(state: &AppState, n: i64) -> String {
    let events = bot_core::recent_events(&state.pool, n).await;
    if events.is_empty() {
        return "No recent alerts.".into();
    }
    let mut out = format!("**🗒 Last {} events**\n", n.clamp(1, 50));
    for e in events {
        out += &format!(
            "<t:{}:t> **{}** {}\n",
            e.at.timestamp(),
            e.title,
            e.body.get(..120).unwrap_or(&e.body)
        );
    }
    out
}

async fn regions_md(state: &AppState) -> String {
    let regions = bot_core::regions_overview(&state.pool).await;
    if regions.is_empty() {
        return "No protected regions.".into();
    }
    let mut out = "**🛡 Protected regions**\n".to_string();
    for r in &regions {
        out += &format!(
            "{} `{},{} {}×{}` — {:.1}%/{:.1}% — **{}**\n",
            r.name,
            r.x,
            r.y,
            r.w,
            r.h,
            r.broken_pct,
            r.tolerance_pct,
            bot_core::region_state_label(r)
        );
    }
    out
}
