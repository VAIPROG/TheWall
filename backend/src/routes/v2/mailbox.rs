//! Unified inbox: announcements + clan alerts + DMs + modmail + template events.
//!
//! Storage shape: one row in mailbox_items per item, polymorphic via `kind`.
//! Broadcast kinds (announcement, clan_alert, clan_announcement) target many
//! recipients — read state lives in mailbox_reads(item_id, user_id). Direct
//! kinds (dm, template_event, modmail reply) target one user — read_at lives
//! on the item itself.
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use super::permissions;
use crate::{AppState, auth::AuthUser};

#[derive(Debug, Serialize, FromRow)]
pub struct MailboxItem {
    pub id: Uuid,
    pub kind: String,
    pub sender_id: Option<Uuid>,
    pub sender_username: Option<String>,
    pub recipient_user_id: Option<Uuid>,
    pub recipient_clan_id: Option<Uuid>,
    pub thread_id: Option<Uuid>,
    pub title: Option<String>,
    pub body: String,
    pub payload: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub read_at: Option<DateTime<Utc>>,
    pub is_read: bool,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub kind: Option<String>,
    pub unread: Option<bool>,
    pub limit: Option<i64>,
    pub cursor: Option<DateTime<Utc>>,
}

/// GET /api/v2/mailbox — everything addressed to this user (direct +
/// broadcast through their clan memberships).
pub async fn list(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<MailboxItem>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(50).min(200);

    // Union of:
    //  - items where recipient_user_id = me (DMs, template events, modmail replies)
    //  - items where recipient_clan_id is one of my active clans
    //    (announcements / clan_alerts) — read state pulled from mailbox_reads
    //  - global announcements (recipient_user_id IS NULL AND recipient_clan_id IS NULL)
    let rows: Vec<MailboxItem> = sqlx::query_as(
        r#"
        WITH my_clans AS (
            SELECT clan_id FROM clan_memberships WHERE user_id = $1 AND active = TRUE
        ),
        candidates AS (
            SELECT i.*,
                   (i.recipient_user_id = $1 AND i.read_at IS NOT NULL)
                   OR EXISTS(SELECT 1 FROM mailbox_reads r WHERE r.item_id = i.id AND r.user_id = $1) AS is_read
              FROM mailbox_items i
             WHERE (i.recipient_user_id = $1)
                OR (i.recipient_clan_id IS NOT NULL AND i.recipient_clan_id IN (SELECT clan_id FROM my_clans))
                -- Global admin broadcasts: 'announcement' (news / toast)
                -- and 'alert' (global popup). Receivers tell them apart by
                -- `kind` and pick the right surface client-side. NOTE:
                -- `clan_alert` is intentionally NOT here — it has a clan
                -- recipient and is delivered through the clan branch above.
                OR (i.kind IN ('announcement', 'alert')
                    AND i.recipient_user_id IS NULL
                    AND i.recipient_clan_id IS NULL)
        )
        SELECT c.id, c.kind, c.sender_id,
               (SELECT username FROM users WHERE id = c.sender_id) AS sender_username,
               c.recipient_user_id, c.recipient_clan_id, c.thread_id,
               c.title, c.body, c.payload, c.created_at, c.read_at, c.is_read
          FROM candidates c
         WHERE ($2::text IS NULL OR c.kind = $2)
           AND ($3::boolean IS NULL OR c.is_read = NOT $3)
           AND ($4::timestamptz IS NULL OR c.created_at < $4)
         ORDER BY c.created_at DESC
         LIMIT $5
        "#,
    )
    .bind(auth.user_id)
    .bind(q.kind.as_deref())
    .bind(q.unread)
    .bind(q.cursor)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    Ok(Json(rows))
}

/// POST /api/v2/mailbox/:id/read
pub async fn mark_read(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Direct target — set read_at if I'm the recipient.
    sqlx::query(
        "UPDATE mailbox_items SET read_at = NOW() WHERE id = $1 AND recipient_user_id = $2 AND read_at IS NULL",
    )
    .bind(id)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    // Broadcast target — upsert a row in mailbox_reads.
    sqlx::query(
        "INSERT INTO mailbox_reads (item_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v2/mailbox/read-all
///
/// Mark every unread mailbox item the current user can see (direct
/// recipient OR broadcast target via clan / global / mod scope) as read.
/// Honours the optional `kind` query param so a user can clear just one
/// channel — e.g. "mark all my DMs as read" without affecting alerts.
pub async fn mark_all_read(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    let kind = q.kind.as_deref();
    // Direct mail: bulk update read_at on rows we own.
    let direct = sqlx::query(
        r#"UPDATE mailbox_items
              SET read_at = NOW()
            WHERE recipient_user_id = $1
              AND read_at IS NULL
              AND ($2::text IS NULL OR kind = $2)"#,
    )
    .bind(auth.user_id)
    .bind(kind)
    .execute(&state.pool)
    .await
    .or_500()?;

    // Broadcast mail: insert a read marker for every item the user is
    // entitled to see but hasn't acked yet. Mirrors the visibility logic
    // from `list` above — the schema (mailbox_items) has no `scope` or
    // `clan_id` column; visibility is encoded via the recipient_user_id /
    // recipient_clan_id pair plus the kind='announcement' global branch.
    let broadcast = sqlx::query(
        r#"INSERT INTO mailbox_reads (item_id, user_id)
           SELECT i.id, $1
             FROM mailbox_items i
            WHERE ($2::text IS NULL OR i.kind = $2)
              AND (
                    (i.recipient_clan_id IS NOT NULL
                       AND i.recipient_clan_id IN (
                           SELECT clan_id FROM clan_memberships
                            WHERE user_id = $1 AND active = TRUE
                       ))
                 OR (i.kind IN ('announcement', 'alert')
                       AND i.recipient_user_id IS NULL
                       AND i.recipient_clan_id IS NULL)
              )
              AND NOT EXISTS(
                    SELECT 1 FROM mailbox_reads r
                     WHERE r.item_id = i.id AND r.user_id = $1
              )
           ON CONFLICT DO NOTHING"#,
    )
    .bind(auth.user_id)
    .bind(kind)
    .execute(&state.pool)
    .await
    .or_500()?;

    Ok(axum::Json(serde_json::json!({
        "direct_marked":    direct.rows_affected(),
        "broadcast_marked": broadcast.rows_affected(),
    })))
}

#[derive(Debug, Deserialize)]
pub struct SendDmRequest {
    pub to: Uuid,
    pub body: String,
    pub title: Option<String>,
}

/// POST /api/v2/mailbox/dm — direct message another user.
pub async fn send_dm(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<SendDmRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if body.body.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "empty body".into()));
    }
    if body.body.chars().count() > state.config.limits.message_chars {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("max {} chars", state.config.limits.message_chars),
        ));
    }
    sqlx::query(
        r#"INSERT INTO mailbox_items
                (id, kind, sender_id, recipient_user_id, title, body)
           VALUES (gen_random_uuid(), 'dm', $1, $2, $3, $4)"#,
    )
    .bind(auth.user_id)
    .bind(body.to)
    .bind(body.title)
    .bind(&body.body)
    .execute(&state.pool)
    .await
    .or_500()?;
    Ok(StatusCode::CREATED)
}

#[derive(Debug, Deserialize)]
pub struct ReplyRequest {
    pub body: String,
}

/// POST /api/v2/mailbox/:id/reply — append a message to a thread (modmail, dm).
pub async fn reply(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ReplyRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if body.body.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "empty body".into()));
    }

    // Fetch the parent so we know who/where to address.
    let parent: Option<(String, Option<Uuid>, Option<Uuid>, Option<Uuid>)> = sqlx::query_as(
        "SELECT kind, sender_id, recipient_user_id, recipient_clan_id FROM mailbox_items WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;
    let parent = parent.ok_or((StatusCode::NOT_FOUND, "thread root not found".into()))?;

    let (kind, sender_id, recipient_user_id, recipient_clan_id) = parent;

    // Authorisation: DMs go between two specific users; modmail allows replies
    // from the opener or any clan moderator of the parent's clan.
    let (target_user, target_clan) = match kind.as_str() {
        "dm" => {
            let other = if Some(auth.user_id) == sender_id {
                recipient_user_id
            } else if Some(auth.user_id) == recipient_user_id {
                sender_id
            } else {
                return Err((StatusCode::FORBIDDEN, "not in this DM thread".into()));
            };
            (other, None)
        }
        "modmail" => {
            // Reply is visible to the opener AND addressed to the clan's mod
            // pool. We model it as a thread child with recipient_clan_id =
            // the clan; the opener also gets a direct copy so they see it
            // in their own mailbox without joining mods.
            let clan = recipient_clan_id
                .ok_or((StatusCode::BAD_REQUEST, "modmail without clan".to_string()))?;
            // Authorisation: opener OR mod.
            let is_opener = Some(auth.user_id) == sender_id;
            let mod_ok = permissions::effective_clan_role(&state.pool, auth.user_id, clan)
                .await
                .or_500()?
                .map(|r| r.is_mod())
                .unwrap_or(false);
            if !is_opener && !mod_ok {
                return Err((StatusCode::FORBIDDEN, "not opener or mod".into()));
            }
            (sender_id, Some(clan))
        }
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                "kind doesn't accept replies".into(),
            ));
        }
    };

    sqlx::query(
        r#"INSERT INTO mailbox_items
                (id, kind, sender_id, recipient_user_id, recipient_clan_id, thread_id, body)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)"#,
    )
    .bind(&kind)
    .bind(auth.user_id)
    .bind(target_user)
    .bind(target_clan)
    .bind(id)
    .bind(&body.body)
    .execute(&state.pool)
    .await
    .or_500()?;

    sqlx::query(
        "UPDATE clan_modmail_threads SET last_activity = NOW() WHERE id IN (SELECT thread_id FROM mailbox_items WHERE id = $1)",
    )
    .bind(id)
    .execute(&state.pool).await.ok();

    Ok(StatusCode::CREATED)
}
