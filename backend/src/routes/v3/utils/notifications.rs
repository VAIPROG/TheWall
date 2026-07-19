//! Notification delivery helper shared by V3 routes.
//!
//! This is a thin wrapper around the canonical producer in
//! `routes::v3::notifications::notify`, which writes the columns the reader
//! actually selects (`type`, `action_url`, `metadata`, `read`, `dismissed_at`)
//! and honours the boolean per-kind opt-outs in `notification_settings`.
//!
//! A previous version of this module wrote `kind/link/meta/read_at` columns
//! that never existed in the schema (and consulted a nonexistent
//! `notification_settings.settings` jsonb), so every insert through it failed
//! at runtime. Keep all producers on the canonical helper.

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
    crate::routes::v3::notifications::notify(pool, user_id, kind, title, body, link, meta).await
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
        "restriction_update",
        "Appeal resolved",
        Some(&format!(
            "Your appeal has been {}. {}",
            status,
            moderator_notes.unwrap_or("")
        )),
        Some("/appeals"),
        json!({"event": "appeal_resolved", "status": status}),
    )
    .await
}
