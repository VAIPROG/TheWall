//! Notification delivery helper shared by V3 routes.

use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

/// Insert a notification for `user_id`.
///
/// Returns the inserted row id on success, or `None` if the user's
/// preferences block this `kind`.
pub async fn notify(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    kind: &str,
    title: &str,
    body: Option<&str>,
    link: Option<&str>,
    meta: serde_json::Value,
) -> Result<Option<Uuid>, sqlx::Error> {
    // Respect per-kind opt-outs stored in notification_settings.
    let allowed: Option<bool> = sqlx::query_scalar(
        r#"SELECT COALESCE(
             (settings -> $2)->>'enabled',
             'true'
           )::boolean
             FROM notification_settings
            WHERE user_id = $1"#,
    )
    .bind(user_id)
    .bind(kind)
    .fetch_optional(pool)
    .await?;

    if allowed == Some(false) {
        return Ok(None);
    }

    let id: Uuid = sqlx::query_scalar(
        r#"INSERT INTO notifications
             (user_id, kind, title, body, link, meta, created_at, read_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
           RETURNING id"#,
    )
    .bind(user_id)
    .bind(kind)
    .bind(title)
    .bind(body)
    .bind(link)
    .bind(meta)
    .bind(Utc::now())
    .fetch_one(pool)
    .await?;

    Ok(Some(id))
}

/// Create a notification when an appeal is resolved.
pub async fn appeal_resolved(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    status: &str,
    moderator_notes: Option<&str>,
) -> Result<Option<Uuid>, sqlx::Error> {
    notify(
        pool,
        user_id,
        "appeal_resolved",
        "Appeal resolved",
        Some(&format!(
            "Your appeal has been {}. {}",
            status,
            moderator_notes.unwrap_or("")
        )),
        Some("/appeals"),
        json!({"status": status}),
    )
    .await
}
