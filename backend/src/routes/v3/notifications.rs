//! V3 notifications endpoints:
//!   GET    /api/v3/notifications
//!   POST   /api/v3/notifications/ack
//!   POST   /api/v3/notifications/ack/all
//!   GET    /api/v3/notifications/{id}
//!   DELETE /api/v3/notifications/{id}
//!   GET    /api/v3/notifications/settings
//!   PATCH  /api/v3/notifications/settings
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{
        AckRequest, NotificationPage, NotificationSettings, NotificationSettingsUpdate,
        NotificationView,
    },
};

#[derive(Debug, Deserialize)]
pub struct ListNotificationsQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    pub read: Option<bool>,
}

// ---------------------------------------------------------------------------
// GET /api/v3/notifications
// ---------------------------------------------------------------------------

pub async fn list_notifications(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ListNotificationsQuery>,
) -> Result<Json<NotificationPage>, (StatusCode, String)> {
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(20).clamp(1, 100);
    let offset = (page - 1) * per_page;

    let mut count_sql =
        "SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND dismissed_at IS NULL".to_string();
    let mut rows_sql = r#"SELECT id, user_id, type, title, body, read, action_url, metadata, created_at, dismissed_at
        FROM notifications
       WHERE user_id = $1 AND dismissed_at IS NULL"#
        .to_string();

    if let Some(read) = q.read {
        count_sql.push_str(&format!(" AND read = {read}"));
        rows_sql.push_str(&format!(" AND read = {read}"));
    }

    rows_sql.push_str(" ORDER BY created_at DESC LIMIT $2 OFFSET $3");

    let total: i64 = sqlx::query_scalar(&count_sql)
        .bind(auth.user_id)
        .fetch_one(&state.pool)
        .await
        .or_500()?;

    let rows = sqlx::query_as::<_, crate::models::Notification>(&rows_sql)
        .bind(auth.user_id)
        .bind(per_page)
        .bind(offset)
        .fetch_all(&state.pool)
        .await
        .or_500()?;

    let items = rows.into_iter().map(into_view).collect();
    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    Ok(Json(NotificationPage { items, page, per_page, total, total_pages }))
}

// ---------------------------------------------------------------------------
// GET /api/v3/notifications/{id}
// ---------------------------------------------------------------------------

pub async fn get_notification(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<NotificationView>, (StatusCode, String)> {
    let row: Option<crate::models::Notification> = sqlx::query_as(
        r#"SELECT id, user_id, type, title, body, read, action_url, metadata, created_at, dismissed_at
             FROM notifications
            WHERE id = $1 AND user_id = $2 AND dismissed_at IS NULL"#,
    )
    .bind(id)
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;

    let row = row.ok_or_else(|| (StatusCode::NOT_FOUND, "notification not found".to_string()))?;
    Ok(Json(into_view(row)))
}

// ---------------------------------------------------------------------------
// DELETE /api/v3/notifications/{id}
// ---------------------------------------------------------------------------

pub async fn dismiss_notification(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let result = sqlx::query(
        "UPDATE notifications SET dismissed_at = NOW() WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "notification not found".to_string()));
    }

    Ok(Json(json!({"ok": true, "message": "dismissed"})))
}

// ---------------------------------------------------------------------------
// POST /api/v3/notifications/ack
// ---------------------------------------------------------------------------

pub async fn ack_notifications(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<AckRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if body.ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "ids required".to_string()));
    }

    sqlx::query(
        "UPDATE notifications SET read = TRUE WHERE id = ANY($1) AND user_id = $2",
    )
    .bind(&body.ids[..])
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    Ok(Json(json!({"ok": true, "message": "acknowledged"})))
}

// ---------------------------------------------------------------------------
// POST /api/v3/notifications/ack/all
// ---------------------------------------------------------------------------

pub async fn ack_all_notifications(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    sqlx::query(
        "UPDATE notifications SET read = TRUE WHERE user_id = $1 AND dismissed_at IS NULL",
    )
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    Ok(Json(json!({"ok": true, "message": "all acknowledged"})))
}

// ---------------------------------------------------------------------------
// GET /api/v3/notifications/settings
// ---------------------------------------------------------------------------

pub async fn get_settings(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<NotificationSettings>, (StatusCode, String)> {
    let row = sqlx::query_as::<_, NotificationSettings>(
        r#"INSERT INTO notification_settings (user_id)
           VALUES ($1)
           ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
           RETURNING user_id, push_enabled, template_status_changes, clan_invites,
                     restriction_updates, mod_actions, system_announcements,
                     news_announcements, mentions, updated_at"#,
    )
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await
    .or_500()?;

    Ok(Json(row))
}

// ---------------------------------------------------------------------------
// PATCH /api/v3/notifications/settings
// ---------------------------------------------------------------------------

pub async fn update_settings(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<NotificationSettingsUpdate>,
) -> Result<Json<NotificationSettings>, (StatusCode, String)> {
    let row = sqlx::query_as::<_, NotificationSettings>(
        r#"UPDATE notification_settings SET
               push_enabled = COALESCE($2, push_enabled),
               template_status_changes = COALESCE($3, template_status_changes),
               clan_invites = COALESCE($4, clan_invites),
               restriction_updates = COALESCE($5, restriction_updates),
               mod_actions = COALESCE($6, mod_actions),
               system_announcements = COALESCE($7, system_announcements),
               news_announcements = COALESCE($8, news_announcements),
               mentions = COALESCE($9, mentions),
               updated_at = NOW()
         WHERE user_id = $1
     RETURNING user_id, push_enabled, template_status_changes, clan_invites,
               restriction_updates, mod_actions, system_announcements,
               news_announcements, mentions, updated_at"#,
    )
    .bind(auth.user_id)
    .bind(body.push_enabled)
    .bind(body.template_status_changes)
    .bind(body.clan_invites)
    .bind(body.restriction_updates)
    .bind(body.mod_actions)
    .bind(body.system_announcements)
    .bind(body.news_announcements)
    .bind(body.mentions)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;

    let row = row.ok_or_else(|| {
        // Create default row if missing for some reason.
        (StatusCode::NOT_FOUND, "notification settings not found".to_string())
    })?;

    Ok(Json(row))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn into_view(n: crate::models::Notification) -> NotificationView {
    NotificationView {
        id: n.id,
        notification_type: n.notification_type,
        title: n.title,
        body: n.body,
        is_read: n.read,
        action_url: n.action_url,
        metadata: if n.metadata.is_null() { None } else { Some(n.metadata) },
        created_at: n.created_at,
    }
}

/// Helper used by other modules to create a notification for a user.
/// Returns the new notification id or None if the user has disabled this type.
pub async fn notify(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    notification_type: &str,
    title: &str,
    body: Option<&str>,
    action_url: Option<&str>,
    metadata: serde_json::Value,
) -> Result<Option<Uuid>, sqlx::Error> {
    let settings = sqlx::query_as::<_, NotificationSettings>(
        r#"INSERT INTO notification_settings (user_id) VALUES ($1)
           ON CONFLICT (user_id) DO NOTHING
           RETURNING *"#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    let default_settings = NotificationSettings {
        user_id,
        push_enabled: false,
        template_status_changes: true,
        clan_invites: true,
        restriction_updates: true,
        mod_actions: true,
        system_announcements: true,
        news_announcements: true,
        mentions: true,
        updated_at: chrono::Utc::now(),
    };

    let settings = settings.unwrap_or(default_settings);

    let enabled = match notification_type {
        "template_status_change" => settings.template_status_changes,
        "clan_invite" => settings.clan_invites,
        "restriction_update" => settings.restriction_updates,
        "mod_action" => settings.mod_actions,
        "system_announcement" => settings.system_announcements,
        "news_announcement" => settings.news_announcements,
        "mention" => settings.mentions,
        _ => true,
    };

    if !enabled {
        return Ok(None);
    }

    let id: Uuid = sqlx::query_scalar(
        r#"INSERT INTO notifications (user_id, type, title, body, action_url, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id"#,
    )
    .bind(user_id)
    .bind(notification_type)
    .bind(title)
    .bind(body)
    .bind(action_url)
    .bind(metadata)
    .fetch_one(pool)
    .await?;

    Ok(Some(id))
}
