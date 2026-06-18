use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AppState, auth::AuthUser, models::ModApplyRequest};

// ---------------------------------------------------------------------------
// Shared error helper
// ---------------------------------------------------------------------------

fn internal_error(e: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("{}", e);
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

// ---------------------------------------------------------------------------
// Clan chat sub-module
// ---------------------------------------------------------------------------

pub mod chat {
    use super::*;

    #[derive(Debug, Deserialize)]
    pub struct ChatQuery {
        pub since: Option<DateTime<Utc>>,
    }

    #[derive(Debug, Serialize, sqlx::FromRow)]
    pub struct ChatMessageResponse {
        pub id: Uuid,
        pub author: String,
        pub text: String,
        pub created_at: DateTime<Utc>,
    }

    /// GET /api/clan/chat?since=<iso_timestamp>
    ///
    /// SECURITY: returns only messages belonging to clans the caller is an
    /// active member of. Without this filter, any authed user could read
    /// every clan's chat — which is exactly what happened pre-migration 014.
    pub async fn list(
        auth: AuthUser,
        State(state): State<AppState>,
        Query(params): Query<ChatQuery>,
    ) -> Result<impl IntoResponse, (StatusCode, String)> {
        let rows: Vec<ChatMessageResponse> = sqlx::query_as::<_, ChatMessageResponse>(
            r#"SELECT id, author, text, created_at
                 FROM clan_messages
                WHERE clan_id IS NOT NULL
                  AND clan_id IN (
                      SELECT clan_id FROM clan_memberships
                       WHERE user_id = $1 AND active = true
                  )
                  AND ($2::timestamptz IS NULL OR created_at > $2)
                ORDER BY created_at ASC"#,
        )
        .bind(auth.user_id)
        .bind(params.since)
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?;

        Ok(Json(rows))
    }

    #[derive(Debug, Deserialize)]
    pub struct CreateMessageRequest {
        pub text: String,
    }

    /// POST /api/clan/chat
    ///
    /// SECURITY: messages are tagged with the caller's first active clan
    /// membership. If the caller has no active membership we refuse the
    /// post; otherwise the message would land as clan_id=NULL and be
    /// invisible to everyone.
    pub async fn create(
        auth: AuthUser,
        State(state): State<AppState>,
        Json(body): Json<CreateMessageRequest>,
    ) -> Result<impl IntoResponse, (StatusCode, String)> {
        #[derive(sqlx::FromRow)]
        struct UsernameRow {
            username: String,
        }

        let user = sqlx::query_as::<_, UsernameRow>("SELECT username FROM users WHERE id = $1")
            .bind(auth.user_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| (StatusCode::UNAUTHORIZED, "User not found".to_string()))?;

        let clan_id: Option<Uuid> = sqlx::query_scalar(
            r#"SELECT clan_id FROM clan_memberships
                WHERE user_id = $1 AND active = true
                ORDER BY joined_at ASC
                LIMIT 1"#,
        )
        .bind(auth.user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal_error)?;

        let clan_id = clan_id.ok_or_else(|| {
            (
                StatusCode::FORBIDDEN,
                "You are not a member of any clan".to_string(),
            )
        })?;

        sqlx::query(
            r#"INSERT INTO clan_messages (id, user_id, clan_id, author, text, created_at)
               VALUES ($1, $2, $3, $4, $5, NOW())"#,
        )
        .bind(Uuid::new_v4())
        .bind(auth.user_id)
        .bind(clan_id)
        .bind(&user.username)
        .bind(&body.text)
        .execute(&state.pool)
        .await
        .map_err(internal_error)?;

        Ok((StatusCode::CREATED, Json(serde_json::json!({"ok": true}))))
    }

    /// DELETE /api/clan/chat/:id
    pub async fn remove(
        auth: AuthUser,
        State(state): State<AppState>,
        Path(id): Path<Uuid>,
    ) -> Result<impl IntoResponse, (StatusCode, String)> {
        #[derive(sqlx::FromRow)]
        struct MsgRow {
            user_id: Uuid,
            clan_id: Option<Uuid>,
        }

        let global_role: String =
            sqlx::query_scalar("SELECT global_role FROM users WHERE id = $1")
                .bind(auth.user_id)
                .fetch_optional(&state.pool)
                .await
                .map_err(internal_error)?
                .unwrap_or_else(|| "user".to_string());

        let msg = sqlx::query_as::<_, MsgRow>(
            "SELECT user_id, clan_id FROM clan_messages WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Message not found".to_string()))?;

        let is_global_admin =
            matches!(global_role.as_str(), "owner" | "admin");
        let is_author = msg.user_id == auth.user_id;

        // Clan-level moderator/admin of the message's clan can also delete.
        let is_clan_mod = if let Some(clan_id) = msg.clan_id {
            let role: Option<String> = sqlx::query_scalar(
                r#"SELECT clan_role FROM clan_memberships
                    WHERE user_id = $1 AND clan_id = $2 AND active = true"#,
            )
            .bind(auth.user_id)
            .bind(clan_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(internal_error)?;
            matches!(role.as_deref(), Some("moderator") | Some("admin"))
        } else {
            false
        };

        if !is_global_admin && !is_clan_mod && !is_author {
            return Err((StatusCode::FORBIDDEN, "Not allowed".to_string()));
        }

        // Also assert the message actually belongs to a clan the caller is in,
        // unless they're a global admin or the author. This blocks the
        // theoretical hole where a clan_id lookup would still resolve for
        // someone who is no longer a member.
        if !is_global_admin && !is_author {
            if let Some(clan_id) = msg.clan_id {
                let is_member: Option<bool> = sqlx::query_scalar(
                    r#"SELECT TRUE FROM clan_memberships
                        WHERE user_id = $1 AND clan_id = $2 AND active = true"#,
                )
                .bind(auth.user_id)
                .bind(clan_id)
                .fetch_optional(&state.pool)
                .await
                .map_err(internal_error)?;
                if is_member.is_none() {
                    return Err((StatusCode::FORBIDDEN, "Not your clan".to_string()));
                }
            }
        }

        sqlx::query("DELETE FROM clan_messages WHERE id = $1")
            .bind(id)
            .execute(&state.pool)
            .await
            .map_err(internal_error)?;

        Ok(StatusCode::NO_CONTENT)
    }
}

// ---------------------------------------------------------------------------
// Clan members sub-module
// ---------------------------------------------------------------------------

pub mod members {
    use super::*;

    #[derive(Debug, Serialize, sqlx::FromRow)]
    pub struct MemberResponse {
        pub id: Uuid,
        pub username: String,
        pub discord_id: Option<String>,
        pub discord_username: Option<String>,
        pub role: String,
        pub has_custom_avatar: bool,
    }

    /// GET /api/clan/members
    ///
    /// SECURITY: returns only fellow members of clans the caller belongs to.
    /// Previously this returned every user in the database.
    pub async fn list(
        auth: AuthUser,
        State(state): State<AppState>,
    ) -> Result<impl IntoResponse, (StatusCode, String)> {
        let rows = sqlx::query_as::<_, MemberResponse>(
            r#"SELECT DISTINCT u.id, u.username, u.discord_id, u.discord_username,
                      m.clan_role AS role,
                      EXISTS(SELECT 1 FROM avatars a WHERE a.user_id = u.id) AS has_custom_avatar
                 FROM users u
                 JOIN clan_memberships m ON m.user_id = u.id AND m.active = true
                WHERE m.clan_id IN (
                    SELECT clan_id FROM clan_memberships
                     WHERE user_id = $1 AND active = true
                )
                ORDER BY u.username ASC"#,
        )
        .bind(auth.user_id)
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?;

        Ok(Json(rows))
    }
}

// ---------------------------------------------------------------------------
// Clan moderation sub-module
// ---------------------------------------------------------------------------

pub mod moderation {
    use super::*;

    /// POST /api/clan/moderation/apply
    pub async fn apply(
        auth: AuthUser,
        State(state): State<AppState>,
        Json(body): Json<ModApplyRequest>,
    ) -> Result<impl IntoResponse, (StatusCode, String)> {
        sqlx::query(
            r#"INSERT INTO moderation_applications (id, user_id, message, status, created_at)
               VALUES ($1, $2, $3, 'pending', NOW())"#,
        )
        .bind(Uuid::new_v4())
        .bind(auth.user_id)
        .bind(&body.message)
        .execute(&state.pool)
        .await
        .map_err(internal_error)?;

        Ok(StatusCode::CREATED)
    }
}

// ---------------------------------------------------------------------------
// Clan templates stub sub-module (referenced in main.rs routing)
// ---------------------------------------------------------------------------

pub mod templates {
    use super::*;

    #[derive(Debug, Serialize, sqlx::FromRow)]
    pub struct ClanTemplateResponse {
        pub id: Uuid,
        pub name: String,
        pub x: i32,
        pub y: i32,
        pub scale: f64,
        pub scope: String,
        pub author: Option<String>,
        pub created_at: DateTime<Utc>,
    }

    /// GET /api/clan/templates
    ///
    /// SECURITY: scope='clan' templates are isolated to the caller's clans.
    /// Previously this returned every clan-scope template regardless of who
    /// owned it.
    pub async fn list(
        auth: AuthUser,
        State(state): State<AppState>,
    ) -> Result<impl IntoResponse, (StatusCode, String)> {
        let rows = sqlx::query_as::<_, ClanTemplateResponse>(
            r#"SELECT id, name, x, y, scale, scope, author, created_at
                 FROM templates
                WHERE scope = 'clan'
                  AND status = 'approved'
                  AND clan_id IS NOT NULL
                  AND clan_id IN (
                      SELECT clan_id FROM clan_memberships
                       WHERE user_id = $1 AND active = true
                  )
                ORDER BY created_at DESC"#,
        )
        .bind(auth.user_id)
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?;

        Ok(Json(rows))
    }
}
