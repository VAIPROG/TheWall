//! User profile endpoints:
//!   GET    /api/v3/users/me
//!   PATCH  /api/v3/users/me
//!   GET    /api/v3/users/{user_ref}

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::json;
use crate::http_error::ResultExt;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ProviderLink, SiteIdentity, SocialAccountPublic, User, UserProfilePublic, UserSelf, UserUpdate},
    routes::v3::utils::{audit, users::resolve_user_ref as resolve_user_ref_util},
};

// ---------------------------------------------------------------------------
// GET /api/v3/users/me
// ---------------------------------------------------------------------------

pub async fn get_me(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<UserSelf>, (StatusCode, String)> {
    let user = load_user(&state.pool, auth.user_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?;

    let avatar_url = avatar_url_for(&state.config, auth.user_id);

    let site_identities: Vec<SiteIdentity> = sqlx::query_as(
        "SELECT id, account_id, source, external_id, site_username, linked_at, last_seen_at
           FROM site_identities
          WHERE account_id = $1
          ORDER BY linked_at DESC",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    let linked_accounts: Vec<ProviderLink> = sqlx::query_as(
        "SELECT id, account_id, provider, provider_uid, username, is_verified, is_public, linked_at
           FROM provider_links
          WHERE account_id = $1
          ORDER BY linked_at DESC",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    let api_key_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM api_keys WHERE user_id = $1")
        .bind(auth.user_id)
        .fetch_one(&state.pool)
        .await
        .or_500()?;

    let block_list_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_blocks WHERE blocker_id = $1")
        .bind(auth.user_id)
        .fetch_one(&state.pool)
        .await
        .or_500()?;

    Ok(Json(UserSelf {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        bio: user.bio,
        lang: user.preferred_lang,
        telemetry_opt_in: user.telemetry_opt_in,
        role: user.role,
        global_role: user.global_role,
        avatar_url,
        created_at: user.created_at,
        updated_at: user.updated_at,
        site_identities,
        linked_accounts,
        api_key_count,
        block_list_count,
    }))
}

// ---------------------------------------------------------------------------
// PATCH /api/v3/users/me
// ---------------------------------------------------------------------------

pub async fn update_me(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<UserUpdate>,
) -> Result<Json<UserSelf>, (StatusCode, String)> {
    let user = load_user(&state.pool, auth.user_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?;

    if let Some(ref d) = body.display_name {
        if d.len() > 64 {
            return Err((StatusCode::BAD_REQUEST, "display name must be ≤64 characters".to_string()));
        }
    }
    if let Some(ref u) = body.username {
        if u.len() < 3 || u.len() > 32 || !u.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err((StatusCode::BAD_REQUEST, "invalid username".to_string()));
        }
        // Check uniqueness if changed.
        if u != &user.username {
            let exists: Option<bool> = sqlx::query_scalar(
                "SELECT TRUE FROM users WHERE lower(username) = lower($1) AND id <> $2",
            )
            .bind(u)
            .bind(auth.user_id)
            .fetch_optional(&state.pool)
            .await
            .or_500()?;
            if exists.is_some() {
                return Err((StatusCode::CONFLICT, "username already taken".to_string()));
            }
        }
    }
    if let Some(ref b) = body.bio {
        if b.len() > 500 {
            return Err((StatusCode::BAD_REQUEST, "bio must be ≤500 characters".to_string()));
        }
    }
    if let Some(ref l) = body.lang {
        if l.len() > 10 {
            return Err((StatusCode::BAD_REQUEST, "lang must be ≤10 characters".to_string()));
        }
    }

    sqlx::query(
        "UPDATE users SET
            display_name = COALESCE($1, display_name),
            username = COALESCE($2, username),
            bio = COALESCE($3, bio),
            preferred_lang = COALESCE($4, preferred_lang),
            telemetry_opt_in = COALESCE($5, telemetry_opt_in),
            updated_at = NOW()
         WHERE id = $6",
    )
    .bind(body.display_name.as_deref())
    .bind(body.username.as_deref())
    .bind(body.bio.as_deref())
    .bind(body.lang.as_deref())
    .bind(body.telemetry_opt_in)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "profile_updated",
        "user",
        &auth.user_id.to_string(),
        json!({
            "displayName": body.display_name,
            "username": body.username,
            "bio": body.bio,
            "lang": body.lang,
            "telemetryOptIn": body.telemetry_opt_in,
        }),
    )
    .await;

    // Reuse get_me to build the response from the updated row.
    get_me(auth, State(state)).await
}

// ---------------------------------------------------------------------------
// GET /api/v3/users/{user_ref}
// ---------------------------------------------------------------------------

pub async fn get_user_by_ref(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<UserProfilePublic>, (StatusCode, String)> {
    let target_id = resolve_user_ref_util(&state.pool, &user_ref, auth.user_id).await?;

    let user = load_user(&state.pool, target_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?;

    let avatar_url = avatar_url_for(&state.config, target_id);

    // Primary clan: the active membership with the highest role, or None.
    let clan_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT clan_id FROM clan_memberships
          WHERE user_id = $1 AND active = TRUE
          ORDER BY CASE clan_role
                     WHEN 'owner' THEN 1
                     WHEN 'admin' THEN 2
                     WHEN 'moderator' THEN 3
                     WHEN 'member' THEN 4
                   END
          LIMIT 1",
    )
    .bind(target_id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;

    let social_accounts: Vec<SocialAccountPublic> = sqlx::query_as(
        "SELECT provider, username, is_verified, linked_at
           FROM provider_links
          WHERE account_id = $1 AND is_public = TRUE
          ORDER BY linked_at DESC",
    )
    .bind(target_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    Ok(Json(UserProfilePublic {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        bio: user.bio,
        avatar_url,
        role: user.global_role,
        clan_id,
        created_at: user.created_at,
        social_accounts,
    }))
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

pub(crate) async fn load_user(
    pool: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<Option<User>, (StatusCode, String)> {
    sqlx::query_as::<_, User>(
        r#"SELECT id, external_id, username, discord_id, discord_username, role,
                  global_role, source, preferred_lang, bio, social_links,
                  telemetry_opt_in, created_at, updated_at, display_name
             FROM users
            WHERE id = $1"#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .or_500()
}

/// Every profile points at the stable avatar endpoint, which serves the
/// custom → Discord → identicon fallback chain. It never returns `None`, so a
/// profile always carries a working, cacheable avatar URL rather than a heavy
/// inline data URL (or nothing at all when no custom avatar is set).
pub(crate) fn avatar_url_for(config: &crate::config::AppConfig, user_id: Uuid) -> Option<String> {
    Some(format!(
        "{}/api/v3/users/{}/avatar",
        crate::routes::v3::templates::render::public_base_url(config),
        user_id
    ))
}
