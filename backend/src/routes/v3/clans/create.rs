//! POST /api/v3/clans/new
//!
//! Creates a new native clan owned by the authenticated user.
//! One clan per owner (409 if the user already owns one).
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ClanCreate, ClanView},
    routes::v3::chats::clan_chat_id,
};

use super::{NATIVE_SOURCE, build_clan_view, load_clan};

pub async fn create_clan(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<ClanCreate>,
) -> Result<(StatusCode, Json<ClanView>), (StatusCode, String)> {
    // ── validate ──────────────────────────────────────────────────────────────
    let name = body.name.trim().to_string();
    if name.len() < 2 || name.len() > 32 {
        return Err((StatusCode::BAD_REQUEST, "name must be 2\u{2013}32 characters".to_string()));
    }
    if let Some(ref desc) = body.description {
        if desc.len() > 500 {
            return Err((StatusCode::BAD_REQUEST, "description must be \u{2264}500 characters".to_string()));
        }
    }

    // ── one-clan-per-owner ────────────────────────────────────────────────────
    let already_owns: Option<bool> =
        sqlx::query_scalar("SELECT TRUE FROM clans WHERE owner_id = $1")
            .bind(auth.user_id)
            .fetch_optional(&state.pool)
            .await
            .or_500()?;
    if already_owns.is_some() {
        return Err((StatusCode::CONFLICT, "already own a clan".to_string()));
    }

    // ── insert clan ───────────────────────────────────────────────────────────
    let new_id = Uuid::new_v4();
    let description = body.description.unwrap_or_default();

    sqlx::query(
        r#"INSERT INTO clans
               (id, source, external_id, name, description, owner_id,
                join_policy, discoverable, verified, stats, settings, moderation)
           VALUES ($1, $2, $3, $4, $5, $6,
                   'invite_only', TRUE, FALSE, '{}', '{}', '{}')"#,
    )
    .bind(new_id)
    .bind(NATIVE_SOURCE)
    .bind(new_id.to_string())
    .bind(&name)
    .bind(&description)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    // ── add owner as admin membership ─────────────────────────────────────────
    sqlx::query(
        r#"INSERT INTO clan_memberships (id, user_id, clan_id, clan_role, active, joined_at)
           VALUES (gen_random_uuid(), $1, $2, 'admin', TRUE, NOW())
           ON CONFLICT (user_id, clan_id) DO UPDATE
               SET active = TRUE, clan_role = 'admin'"#,
    )
    .bind(auth.user_id)
    .bind(new_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    // ── create clan chat ──────────────────────────────────────────────────────
    clan_chat_id(&state.pool, new_id).await?;

    // ── load & return ─────────────────────────────────────────────────────────
    let clan = load_clan(&state.pool, new_id)
        .await?
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "clan vanished after insert".to_string()))?;

    let view = build_clan_view(&state.pool, Some(auth.user_id), clan).await?;
    Ok((StatusCode::CREATED, Json(view)))
}
