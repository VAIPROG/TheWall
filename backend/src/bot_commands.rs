//! Telegram admin-command bot.
//!
//! Long-polls `getUpdates` and answers slash commands from authorised
//! principals (bot_admins registry, seeded from TELEGRAM_ADMIN_IDS /
//! DISCORD_ADMIN_IDS at boot). Non-admin messages are ignored entirely — the
//! bot stays silent to strangers, so it can't be used to probe the system.
//!
//! The data behind every answer lives in crate::bot_core (shared with the
//! Discord interactions endpoint); this file only formats it as rich HTML
//! (telegram_rich, with automatic plain-HTML fallback).

use std::time::Duration;

use serde_json::Value;
use sqlx::PgPool;

use crate::bot_core;
use crate::telegram_rich::{esc, send_rich_html};
use crate::{NotifyTargets, OAuthConfig};

pub fn spawn(pool: PgPool, oauth: OAuthConfig, notify: NotifyTargets) {
    let Some(token) = oauth.telegram_bot_token.clone() else {
        tracing::info!("bot_commands: no TELEGRAM_BOT_TOKEN — command bot disabled");
        return;
    };
    tokio::spawn(async move {
        // Seed env-configured admins into the persistent registry.
        for (platform, ids) in [
            ("telegram", &notify.telegram_admin_ids),
            ("discord", &notify.discord_admin_ids),
        ] {
            for id in ids {
                let _ = sqlx::query(
                    r#"INSERT INTO bot_admins (platform, external_id, label)
                       VALUES ($1, $2, 'env-seeded')
                       ON CONFLICT DO NOTHING"#,
                )
                .bind(platform)
                .bind(id)
                .execute(&pool)
                .await;
            }
        }

        let client = reqwest::Client::new();
        let mut offset: i64 = 0;
        tracing::info!("bot_commands: telegram command bot started");
        loop {
            match poll_once(&client, &token, &mut offset, &pool).await {
                Ok(()) => {}
                Err(e) => {
                    tracing::warn!("bot_commands poll: {e}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
}

async fn poll_once(
    client: &reqwest::Client,
    token: &str,
    offset: &mut i64,
    pool: &PgPool,
) -> Result<(), String> {
    let url = format!(
        "https://api.telegram.org/bot{token}/getUpdates?timeout=50&offset={}&allowed_updates=[\"message\"]",
        *offset
    );
    let r = client
        .get(&url)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    let Some(updates) = v.get("result").and_then(|r| r.as_array()) else {
        return Err(format!("bad getUpdates response: {v}"));
    };
    for u in updates {
        if let Some(id) = u.get("update_id").and_then(|i| i.as_i64()) {
            *offset = (*offset).max(id + 1);
        }
        let Some(msg) = u.get("message") else { continue };
        let Some(text) = msg.pointer("/text").and_then(|t| t.as_str()) else { continue };
        if !text.starts_with('/') {
            continue;
        }
        let from_id = msg
            .pointer("/from/id")
            .and_then(|i| i.as_i64())
            .map(|i| i.to_string())
            .unwrap_or_default();
        let chat_id = msg
            .pointer("/chat/id")
            .and_then(|i| i.as_i64())
            .map(|i| i.to_string())
            .unwrap_or_default();
        if from_id.is_empty() || chat_id.is_empty() {
            continue;
        }
        // Admins get the full set; any LINKED Wall account gets /me and
        // /clan_chat. Total strangers are ignored entirely.
        let is_admin = bot_core::is_bot_admin(pool, "telegram", &from_id).await;
        let linked = bot_core::find_user_by_platform(pool, "telegram", &from_id).await;
        if !is_admin && linked.is_none() {
            continue; // silent to strangers
        }
        let reply = handle_command(pool, text, is_admin, linked).await;
        if let Err(e) = send_rich_html(client, token, &chat_id, &reply, false).await {
            tracing::warn!("bot reply: {e}");
        }
    }
    Ok(())
}

async fn handle_command(
    pool: &PgPool,
    text: &str,
    is_admin: bool,
    linked: Option<(uuid::Uuid, String)>,
) -> String {
    let mut parts = text.split_whitespace();
    let cmd = parts
        .next()
        .unwrap_or("")
        .split('@')
        .next()
        .unwrap_or("")
        .to_lowercase();
    let arg = parts.next();
    let rest: String = {
        let mut it = text.split_whitespace();
        it.next();
        it.collect::<Vec<_>>().join(" ")
    };

    // Linked-user commands — available to every account with Telegram linked.
    match cmd.as_str() {
        "/me" => {
            return match &linked {
                Some((uid, _)) => me_html(pool, *uid).await,
                None => "<p>⛔ No Wall account is linked to this Telegram. Link it from the extension (Settings → Linked accounts).</p>".into(),
            };
        }
        "/clan_chat" => {
            return match &linked {
                Some((uid, _)) => {
                    let n = arg.and_then(|a| a.parse().ok()).unwrap_or(10);
                    clan_chat_html(pool, *uid, n).await
                }
                None => "<p>⛔ Link your Telegram first (extension → Settings → Linked accounts).</p>".into(),
            };
        }
        "/clan_say" => {
            return match &linked {
                Some((uid, username)) => {
                    match bot_core::clan_send_message(pool, *uid, username, &rest).await {
                        Ok(()) => "<p>📨 Sent to your clan chat.</p>".into(),
                        Err(e) => format!("<p>⛔ {}</p>", esc(&e)),
                    }
                }
                None => "<p>⛔ Link your Telegram first (extension → Settings → Linked accounts).</p>".into(),
            };
        }
        _ => {}
    }

    if !is_admin {
        return "<p>Available to you: <code>/me</code>, <code>/clan_chat [n]</code>, <code>/clan_say &lt;text&gt;</code>.</p>".into();
    }

    match cmd.as_str() {
        "/help" => help_html(),
        "/status" => status_html(pool).await,
        "/user_count" => user_count_html(pool).await,
        "/snapshot" => snapshot_html(pool).await,
        "/logs" => logs_html(pool, arg.and_then(|a| a.parse().ok()).unwrap_or(10)).await,
        "/regions" => regions_html(pool).await,
        _ => format!(
            "<p>Unknown command <code>{}</code>.</p>{}",
            esc(&cmd),
            help_html()
        ),
    }
}

async fn me_html(pool: &PgPool, uid: uuid::Uuid) -> String {
    let Some(d) = bot_core::me_data(pool, uid).await else {
        return "<p>⛔ Profile not found.</p>".into();
    };
    format!(
        "<h3>👤 {}</h3>\
         <table bordered>\
         <tr><td>Role</td><td>{}</td></tr>\
         <tr><td>Clan</td><td>{}{}</td></tr>\
         <tr><td>Pixels placed</td><td>{}</td></tr>\
         <tr><td>Links</td><td>{} Telegram · {} Discord</td></tr>\
         </table>",
        esc(&d.username),
        esc(&d.global_role),
        esc(d.clan_name.as_deref().unwrap_or("—")),
        d.clan_role.map(|r| format!(" · {}", esc(&r))).unwrap_or_default(),
        d.pixels_placed,
        if d.telegram_linked { "✅" } else { "—" },
        if d.discord_linked { "✅" } else { "—" },
    )
}

async fn clan_chat_html(pool: &PgPool, uid: uuid::Uuid, n: i64) -> String {
    match bot_core::clan_recent_messages(pool, uid, n).await {
        Err(e) => format!("<p>⛔ {}</p>", esc(&e)),
        Ok(rows) if rows.is_empty() => "<p>Clan chat is empty.</p>".into(),
        Ok(rows) => {
            let mut out = format!("<h3>💬 Last {} clan messages</h3>", rows.len());
            for m in rows {
                out += &format!(
                    "<p><tg-time unix=\"{}\" format=\"T\">{}</tg-time> <b>{}</b>: {}</p>",
                    m.at.timestamp(),
                    m.at.format("%H:%M"),
                    esc(&m.author),
                    esc(m.text.get(..200).unwrap_or(&m.text)),
                );
            }
            out
        }
    }
}

fn help_html() -> String {
    "<h3>🧱 The Wall Dev — bot</h3>\
     <table bordered>\
     <tr><th>Command</th><th>What it does</th></tr>\
     <tr><td><code>/me</code></td><td>Your Wall profile (any linked account)</td></tr>\
     <tr><td><code>/clan_chat [n]</code></td><td>Recent clan messages (any linked account)</td></tr>\
     <tr><td><code>/clan_say &lt;text&gt;</code></td><td>Post to your clan chat (any linked account)</td></tr>\
     <tr><td><code>/status</code></td><td>Server vitals: users, templates, last snapshot</td></tr>\
     <tr><td><code>/user_count</code></td><td>Registered users + active sessions</td></tr>\
     <tr><td><code>/snapshot</code></td><td>Latest wall snapshot links</td></tr>\
     <tr><td><code>/logs [n]</code></td><td>Recent events (alerts, scans, snapshots)</td></tr>\
     <tr><td><code>/regions</code></td><td>Protected regions and their status</td></tr>\
     <tr><td><code>/help</code></td><td>This table</td></tr>\
     </table>"
        .to_string()
}

async fn status_html(pool: &PgPool) -> String {
    let d = bot_core::status_data(pool).await;
    let snap_line = d
        .last_snapshot
        .map(|t| {
            format!(
                "<tg-time unix=\"{}\" format=\"DT\">{}</tg-time>",
                t.timestamp(),
                t.format("%H:%M UTC")
            )
        })
        .unwrap_or_else(|| "never".into());
    format!(
        "<h3>📟 Status</h3>\
         <table bordered>\
         <tr><td>Users</td><td>{}</td></tr>\
         <tr><td>Active sessions</td><td>{}</td></tr>\
         <tr><td>Templates</td><td>{}</td></tr>\
         <tr><td>Protected regions</td><td>{} ({} 🔴)</td></tr>\
         <tr><td>Last snapshot</td><td>{snap_line}</td></tr>\
         </table>",
        d.users, d.sessions, d.templates, d.regions_enabled, d.regions_broken
    )
}

async fn user_count_html(pool: &PgPool) -> String {
    let d = bot_core::user_count_data(pool).await;
    format!(
        "<p><b>{}</b> users · <b>{}</b> active today · <b>{}</b> live sessions</p>",
        d.users, d.active_today, d.sessions
    )
}

async fn snapshot_html(pool: &PgPool) -> String {
    let links = bot_core::latest_snapshot(pool).await;
    if links.is_empty() {
        return "<p>No snapshots stored yet.</p>".into();
    }
    let ts = links[0].at;
    let mut out = format!(
        "<h3>📸 Latest snapshot</h3><p><tg-time unix=\"{}\" format=\"DT\">{}</tg-time></p><ul>",
        ts.timestamp(),
        ts.format("%Y-%m-%d %H:%M UTC")
    );
    for l in links {
        match l.url {
            Some(url) if !url.is_empty() => {
                out += &format!("<li><a href=\"{}\">{}</a></li>", esc(&url), esc(&l.size));
            }
            _ => out += &format!("<li>{} — (no url)</li>", esc(&l.size)),
        }
    }
    out + "</ul>"
}

async fn logs_html(pool: &PgPool, n: i64) -> String {
    let events = bot_core::recent_events(pool, n).await;
    let mut out = format!("<h3>🗒 Last {} events</h3>", n.clamp(1, 50));
    if events.is_empty() {
        out += "<p>No recent alerts.</p>";
    } else {
        out += "<table bordered striped><tr><th>When</th><th>Event</th></tr>";
        for e in events {
            out += &format!(
                "<tr><td><tg-time unix=\"{}\" format=\"T\">{}</tg-time></td><td><b>{}</b> {}</td></tr>",
                e.at.timestamp(),
                e.at.format("%H:%M"),
                esc(&e.title),
                esc(e.body.get(..120).unwrap_or(&e.body)),
            );
        }
        out += "</table>";
    }
    out
}

async fn regions_html(pool: &PgPool) -> String {
    let regions = bot_core::regions_overview(pool).await;
    if regions.is_empty() {
        return "<p>No protected regions.</p>".into();
    }
    let mut out = "<h3>🛡 Protected regions</h3>\
                   <table bordered striped>\
                   <tr><th>Region</th><th>Rect</th><th>Broken</th><th>State</th></tr>"
        .to_string();
    for r in &regions {
        out += &format!(
            "<tr><td>{}</td><td><code>{},{} {}×{}</code></td><td>{:.1}% / {:.1}%</td><td>{}</td></tr>",
            esc(&r.name),
            r.x,
            r.y,
            r.w,
            r.h,
            r.broken_pct,
            r.tolerance_pct,
            bot_core::region_state_label(r)
        );
    }
    out + "</table>"
}
