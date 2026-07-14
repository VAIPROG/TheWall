//! Paint-reminder delivery loop.
//!
//! Sweeps `paint_reminders` every 10 seconds and DMs each due row through the
//! user's linked channel: 'telegram' / 'discord' explicitly, or 'auto' =
//! Telegram first (rich message), Discord as fallback. Rows are marked sent
//! even when delivery fails after retq — a reminder that can't be delivered
//! shouldn't be retried forever; the failure is logged for the operator.

use std::time::Duration;

use serde_json::json;
use sqlx::PgPool;
use tokio::time::{MissedTickBehavior, interval};
use uuid::Uuid;

use crate::OAuthConfig;
use crate::bots::outbound::{esc, send_rich_html};

const TICK: Duration = Duration::from_secs(10);
const BATCH: i64 = 20;

use rand::Rng;

const TITLES: &[&str] = &[
    "🎨 Can refilled",
    "🎨 Tank full",
    "🎨 Fresh load",
    "🎨 Paint reloaded",
    "🎨 Spray ready",
];

const BODIES: &[&str] = &[
    "Your spray can is full.\nThe wall is waiting.",
    "Ink tank topped up.\nGo make your mark.",
    "Can is heavy again.\nThe streets are calling.",
    "Fresh paint loaded.\nTime to hit the wall.",
    "Tank full.\nThe blocks are empty.",
];

fn tg_refill_html(note: &str) -> String {
    let mut rng = rand::thread_rng();
    let title = TITLES[rng.gen_range(0..TITLES.len())];
    let body = BODIES[rng.gen_range(0..BODIES.len())].replace('\n', "<br>");

    let footer = if note.is_empty() {
        String::new()
    } else {
        format!("<footer>{}</footer>", esc(note))
    };

    format!("<h3>{}</h3><p>{}</p>{}", title, body, footer)
}

fn dc_refill_message(note: &str) -> String {
    let mut rng = rand::thread_rng();
    let title = TITLES[rng.gen_range(0..TITLES.len())];
    let body = BODIES[rng.gen_range(0..BODIES.len())];
    let mut message = format!("# {}\n{}", title, body);

    if !note.is_empty() {
        message.push_str(&format!("\n> {}", note));
    }

    message
}

#[derive(Debug, sqlx::FromRow)]
struct DueReminder {
    id: Uuid,
    user_id: Uuid,
    note: String,
    channel: String,
    telegram_user_id: Option<String>,
    discord_id: Option<String>,
    username: String,
}

pub fn spawn(pool: PgPool, oauth: OAuthConfig) {
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let mut t = interval(TICK);
        t.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            t.tick().await;
            if let Err(e) = tick(&pool, &client, &oauth).await {
                tracing::warn!("reminder worker: {e}");
            }
        }
    });
}

async fn tick(
    pool: &PgPool,
    client: &reqwest::Client,
    oauth: &OAuthConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let due: Vec<DueReminder> = sqlx::query_as(
        r#"SELECT r.id, r.user_id, r.note, r.channel,
                  u.telegram_user_id, u.discord_id, u.username
             FROM paint_reminders r
             JOIN users u ON u.id = r.user_id
            WHERE NOT r.sent AND r.due_at <= NOW()
            ORDER BY r.due_at ASC
            LIMIT $1"#,
    )
    .bind(BATCH)
    .fetch_all(pool)
    .await?;

    for r in due {
        let delivered = deliver(client, oauth, &r).await;
        if let Err(ref e) = delivered {
            tracing::warn!("reminder {} for {}: {e}", r.id, r.username);
        }
        // Additive: also fan out to any bot_subscriptions of kind 'paint' for
        // this user (self-contained plain sender; existing deliver() untouched).
        let sub_body = if r.note.is_empty() {
            "Your paint has refilled."
        } else {
            r.note.as_str()
        };
        crate::bots::outbound::deliver_user_kind(
            pool,
            client,
            oauth,
            r.user_id,
            "paint",
            "🎨 Paint ready",
            sub_body,
        )
        .await;
        let _ =
            sqlx::query("UPDATE paint_reminders SET sent = TRUE, sent_at = NOW() WHERE id = $1")
                .bind(r.id)
                .execute(pool)
                .await;
    }
    Ok(())
}

async fn deliver(
    client: &reqwest::Client,
    oauth: &OAuthConfig,
    r: &DueReminder,
) -> Result<(), String> {
    let try_tg = r.channel != "discord" && r.telegram_user_id.is_some();
    let try_dc = r.channel != "telegram" && r.discord_id.is_some();

    if try_tg {
        if let Some(tok) = oauth.telegram_bot_token.as_deref() {
            let chat = r.telegram_user_id.as_deref().unwrap();
            let html = tg_refill_html(&r.note);
            match send_rich_html(client, tok, chat, &html, false).await {
                Ok(()) => return Ok(()),
                Err(e) if r.channel == "telegram" => return Err(e),
                Err(e) => tracing::debug!("reminder tg path failed, trying discord: {e}"),
            }
        }
    }
    if try_dc {
        if let Some(tok) = oauth.discord_bot_token.as_deref() {
            let uid = r.discord_id.as_deref().unwrap();
            return discord_dm(client, tok, uid, &r.note).await;
        }
    }
    Err("no deliverable channel (bot tokens or links missing)".into())
}

/// Open (or reuse) the bot↔user DM channel and post the reminder.
async fn discord_dm(
    client: &reqwest::Client,
    bot_token: &str,
    discord_user_id: &str,
    note: &str,
) -> Result<(), String> {
    let dm: serde_json::Value = client
        .post("https://discord.com/api/v10/users/@me/channels")
        .header("Authorization", format!("Bot {bot_token}"))
        .json(&json!({ "recipient_id": discord_user_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let channel_id = dm
        .get("id")
        .and_then(|i| i.as_str())
        .ok_or_else(|| format!("DM channel open failed: {dm}"))?;

    let content = dc_refill_message(note);

    let r = client
        .post(format!(
            "https://discord.com/api/v10/channels/{channel_id}/messages"
        ))
        .header("Authorization", format!("Bot {bot_token}"))
        .json(&json!({ "content": content }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if r.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "discord message {}: {}",
            r.status(),
            r.text().await.unwrap_or_default()
        ))
    }
}
