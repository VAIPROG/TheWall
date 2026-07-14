//! Outbound delivery to bot subscribers (bot_subscriptions). Self-contained —
//! plain Telegram sendMessage + Discord channel message; no telegram_rich dep.
use crate::OAuthConfig;
use serde_json::json;
use sqlx::PgPool;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Send one text message to a subscription target.
async fn send_one(
    client: &reqwest::Client,
    oauth: &OAuthConfig,
    platform: &str,
    chat_id: &str,
    title: &str,
    body: &str,
) {
    match platform {
        "telegram" => {
            let Some(tok) = oauth.telegram_bot_token.as_deref() else {
                return;
            };
            let text = format!("<b>{}</b>\n{}", esc(title), esc(body));
            let url = format!("https://api.telegram.org/bot{tok}/sendMessage");
            let r = client
                .post(&url)
                .json(&json!({"chat_id":chat_id,"text":text,"parse_mode":"HTML"}))
                .send()
                .await;
            if let Ok(resp) = r {
                if !resp.status().is_success() {
                    tracing::debug!(
                        "sub tg send {}: {}",
                        resp.status(),
                        resp.text().await.unwrap_or_default()
                    );
                }
            }
        }
        "discord" => {
            let Some(tok) = oauth.discord_bot_token.as_deref() else {
                return;
            };
            let url = format!("https://discord.com/api/v10/channels/{chat_id}/messages");
            let content = format!("**{title}**\n{body}");
            let r = client
                .post(&url)
                .header("Authorization", format!("Bot {tok}"))
                .json(&json!({ "content": content }))
                .send()
                .await;
            if let Ok(resp) = r {
                if !resp.status().is_success() {
                    tracing::debug!(
                        "sub discord send {}: {}",
                        resp.status(),
                        resp.text().await.unwrap_or_default()
                    );
                }
            }
        }
        _ => {}
    }
}

/// Deliver to a specific user's subscriptions of `kind` (used by paint reminders).
pub async fn deliver_user_kind(
    pool: &PgPool,
    client: &reqwest::Client,
    oauth: &OAuthConfig,
    user_id: uuid::Uuid,
    kind: &str,
    title: &str,
    body: &str,
) {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT platform, chat_id FROM bot_subscriptions WHERE user_id=$1 AND kind=$2",
    )
    .bind(user_id)
    .bind(kind)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for (platform, chat_id) in rows {
        send_one(client, oauth, &platform, &chat_id, title, body).await;
    }
}

/// Deliver to ALL subscribers of `kind` (used by region alerts — not user-scoped).
pub async fn deliver_kind(
    pool: &PgPool,
    client: &reqwest::Client,
    oauth: &OAuthConfig,
    kind: &str,
    title: &str,
    body: &str,
) {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT platform, chat_id FROM bot_subscriptions WHERE kind=$1")
            .bind(kind)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
    for (platform, chat_id) in rows {
        send_one(client, oauth, &platform, &chat_id, title, body).await;
    }
}
