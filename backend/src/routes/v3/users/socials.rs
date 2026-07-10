//! Social account endpoints.
//!
//!   GET    /api/v3/users/me/socials
//!   POST   /api/v3/users/me/socials
//!   PATCH  /api/v3/users/me/socials/{provider}
//!   DELETE /api/v3/users/me/socials/{provider}
//!   GET    /api/v3/users/{userRef}/socials

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::json;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ProviderLink, SocialAccountPublic},
    routes::v3::utils::{audit, users::resolve_user_ref},
};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialLinkCreate {
    pub provider: String,
    pub provider_uid: String,
    pub username: Option<String>,
    pub is_public: Option<bool>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialLinkUpdate {
    pub is_public: Option<bool>,
    pub username: Option<String>,
}

pub async fn get_my_socials(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<ProviderLink>>, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, ProviderLink>(
        "SELECT id, account_id, provider, provider_uid, username, is_verified, is_public, linked_at
           FROM provider_links
          WHERE account_id = $1
          ORDER BY linked_at DESC",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows))
}

pub async fn add_my_social(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<SocialLinkCreate>,
) -> Result<Json<ProviderLink>, (StatusCode, String)> {
    if !matches!(body.provider.as_str(), "discord" | "telegram" | "github") {
        return Err((StatusCode::BAD_REQUEST, "unsupported provider".to_string()));
    }
    if body.provider_uid.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "provider_uid required".to_string()));
    }

    let row = sqlx::query_as::<_, ProviderLink>(
        r#"INSERT INTO provider_links (account_id, provider, provider_uid, username, is_public)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (provider, provider_uid) DO UPDATE SET
               username = EXCLUDED.username,
               is_public = EXCLUDED.is_public,
               linked_at = NOW()
           RETURNING id, account_id, provider, provider_uid, username, is_verified, is_public, linked_at"#,
    )
    .bind(auth.user_id)
    .bind(&body.provider)
    .bind(&body.provider_uid)
    .bind(body.username.as_deref())
    .bind(body.is_public.unwrap_or(false))
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "social_link_added",
        "provider_link",
        &row.id.to_string(),
        json!({ "provider": body.provider }),
    )
    .await;

    Ok(Json(row))
}

pub async fn update_my_social(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(provider): Path<String>,
    Json(body): Json<SocialLinkUpdate>,
) -> Result<Json<ProviderLink>, (StatusCode, String)> {
    let row = sqlx::query_as::<_, ProviderLink>(
        r#"UPDATE provider_links
              SET is_public = COALESCE($3, is_public),
                  username = COALESCE($4, username),
                  linked_at = NOW()
            WHERE account_id = $1 AND provider = $2
        RETURNING id, account_id, provider, provider_uid, username, is_verified, is_public, linked_at"#,
    )
    .bind(auth.user_id)
    .bind(&provider)
    .bind(body.is_public)
    .bind(body.username.as_deref())
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let row = row.ok_or_else(|| (StatusCode::NOT_FOUND, "social link not found".to_string()))?;

    Ok(Json(row))
}

pub async fn delete_my_social(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(provider): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let result = sqlx::query(
        "DELETE FROM provider_links WHERE account_id = $1 AND provider = $2",
    )
    .bind(auth.user_id)
    .bind(&provider)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "social link not found".to_string()));
    }

    Ok(Json(json!({"ok": true, "message": "social link removed"})))
}

pub async fn get_user_socials(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<Vec<SocialAccountPublic>>, (StatusCode, String)> {
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    let rows = sqlx::query_as::<_, SocialAccountPublic>(
        "SELECT provider, username, is_verified, linked_at
           FROM provider_links
          WHERE account_id = $1 AND is_public = TRUE
          ORDER BY linked_at DESC",
    )
    .bind(target_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows))
}
