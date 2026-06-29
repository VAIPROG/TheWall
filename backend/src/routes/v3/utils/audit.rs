//! Moderation audit log helper.
//!
//! `log_action` inserts a row into `mod_audit_log`. Callers can choose
//! to ignore the returned error (best-effort logging) or propagate it.

use sqlx::PgPool;
use uuid::Uuid;

/// Insert a moderation audit event.
///
/// - `moderator_id`: the actor performing the action.
/// - `action`: string key, e.g. `"restriction_created"`.
/// - `target_type`: e.g. `"user"`, `"clan"`, `"restriction"`.
/// - `target_id`: UUID (or other id) as a string.
/// - `details`: arbitrary JSON context.
pub async fn log_action(
    pool: &PgPool,
    moderator_id: Uuid,
    action: &str,
    target_type: &str,
    target_id: &str,
    details: serde_json::Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO mod_audit_log (id, moderator_id, action, target_type, target_id, details)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)"#,
    )
    .bind(moderator_id)
    .bind(action)
    .bind(target_type)
    .bind(target_id)
    .bind(details)
    .execute(pool)
    .await?;
    Ok(())
}
