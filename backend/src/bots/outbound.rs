//! Outbound delivery to bot subscribers (bot_subscriptions). Self-contained —
//! plain Telegram sendMessage + Discord channel message; no telegram_rich dep.
use crate::OAuthConfig;
use serde_json::json;
use sqlx::PgPool;

/// Escape user-supplied text for inclusion in HTML bodies.
pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Send rich HTML to a chat. `silent` maps to `disable_notification`.
///
/// Wraps the Bot API `sendRichMessage` method (rich HTML: headings, tables,
/// collapsible <details>, media blocks, …). Not every Bot API deployment has
/// the method yet, and a malformed rich body is easy to produce, so every send
/// falls back to plain `sendMessage` with `parse_mode=HTML` (classic tag
/// subset) when the rich call is rejected — an alert must never be lost to a
/// formatting problem. (Migrated from the legacy `telegram_rich` in Task 7.)
pub async fn send_rich_html(
    client: &reqwest::Client,
    token: &str,
    chat_id: &str,
    html: &str,
    silent: bool,
) -> Result<(), String> {
    let url = format!("https://api.telegram.org/bot{token}/sendRichMessage");
    let body = json!({
        "chat_id": chat_id,
        "rich_message": { "html": html },
        "disable_notification": silent,
    });
    let r = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if r.status().is_success() {
        return Ok(());
    }
    let rich_err = format!("sendRichMessage {}: {}", r.status(), r.text().await.unwrap_or_default());
    tracing::debug!("{rich_err} — falling back to sendMessage");

    // Fallback: classic sendMessage supports only the basic inline tag set —
    // strip block tags we commonly emit so the fallback doesn't 400 too.
    let plain = downgrade_html(html);
    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    let body = json!({
        "chat_id": chat_id,
        "text": plain,
        "parse_mode": "HTML",
        "disable_notification": silent,
    });
    let r2 = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if r2.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "{rich_err}; fallback sendMessage {}: {}",
            r2.status(),
            r2.text().await.unwrap_or_default()
        ))
    }
}

/// Best-effort downgrade of rich HTML to the classic sendMessage tag subset
/// (b/i/u/s/code/pre/a/blockquote/tg-spoiler). Block elements become line
/// breaks; tables collapse to pipe-separated rows.
fn downgrade_html(html: &str) -> String {
    let mut s = html.to_string();
    // Newline-producing closers first.
    for tag in ["</h1>", "</h2>", "</h3>", "</h4>", "</h5>", "</h6>", "</p>", "</li>", "</tr>", "</table>", "</details>", "</summary>", "</footer>", "<hr/>", "<hr>"] {
        s = s.replace(tag, "\n");
    }
    s = s.replace("</td>", " | ").replace("</th>", " | ");
    // Headings keep emphasis via <b>.
    for (open, close) in [("<h1>", "<b>"), ("<h2>", "<b>"), ("<h3>", "<b>"), ("<h4>", "<b>"), ("<h5>", "<b>"), ("<h6>", "<b>")] {
        s = s.replace(open, close);
    }
    for h in ["</h1", "</h2", "</h3", "</h4", "</h5", "</h6"] {
        s = s.replace(&format!("{h}>"), "</b>");
    }
    // Drop structural tags entirely.
    for tag in ["<table bordered striped>", "<table bordered>", "<table>", "<tr>", "<td>", "<th>", "<ul>", "</ul>", "<ol>", "</ol>", "<li>", "<p>", "<details>", "<details open>", "<summary>", "<footer>", "<caption>", "</caption>", "<mark>", "</mark>"] {
        s = s.replace(tag, "");
    }
    s
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
