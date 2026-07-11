//! API key endpoints.
//!
//!   GET    /api/v3/users/me/keys
//!   POST   /api/v3/users/me/keys
//!   GET    /api/v3/users/me/keys/{id}
//!   PATCH  /api/v3/users/me/keys/{id}
//!   DELETE /api/v3/users/me/keys/{id}
//!   POST   /api/v3/users/me/keys/{id}/request-higher-limits
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use rand::RngCore;
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ApiKeyCreated, ApiKeyCreate, ApiKeyMeta, ApiKeyRow, ApiKeyUpdate},
    routes::v3::utils::audit,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use sha2::{Digest, Sha256};

fn generate_api_key() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("vai_{}", BASE64.encode(&bytes).replace(['/', '+'], "_"))
}

fn hash_key(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    BASE64.encode(hasher.finalize())
}

fn prefix_from(key: &str) -> String {
    key.chars().take(8).collect()
}

async fn load_key(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    key_id: Uuid,
) -> Result<Option<ApiKeyRow>, (StatusCode, String)> {
    sqlx::query_as::<_, ApiKeyRow>(
        r#"SELECT id, user_id, name, prefix, token_hash, permissions, created_at, last_used_at
             FROM api_keys
            WHERE id = $1 AND user_id = $2"#,
    )
    .bind(key_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .or_500()
}

fn meta_from_row(row: &ApiKeyRow) -> ApiKeyMeta {
    ApiKeyMeta {
        id: row.id,
        name: row.name.clone(),
        prefix: row.prefix.clone(),
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        permissions: row.permissions.clone(),
    }
}

pub async fn get_my_keys(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<ApiKeyMeta>>, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, ApiKeyRow>(
        r#"SELECT id, user_id, name, prefix, token_hash, permissions, created_at, last_used_at
             FROM api_keys
            WHERE user_id = $1
            ORDER BY created_at DESC"#,
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    Ok(Json(rows.iter().map(meta_from_row).collect()))
}

pub async fn create_key(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<ApiKeyCreate>,
) -> Result<(StatusCode, Json<ApiKeyCreated>), (StatusCode, String)> {
    let name = body.name.trim();
    if name.is_empty() || name.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "name must be 1–64 characters".to_string()));
    }

    let perms = body.permissions.unwrap_or_default();
    let key = generate_api_key();
    let token_hash = hash_key(&key);
    let prefix = prefix_from(&key);

    let row = sqlx::query_as::<_, ApiKeyRow>(
        r#"INSERT INTO api_keys (user_id, name, prefix, token_hash, permissions)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, user_id, name, prefix, token_hash, permissions, created_at, last_used_at"#,
    )
    .bind(auth.user_id)
    .bind(name)
    .bind(&prefix)
    .bind(&token_hash)
    .bind(&perms)
    .fetch_one(&state.pool)
    .await
    .or_500()?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "api_key_created",
        "api_key",
        &row.id.to_string(),
        json!({}),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(ApiKeyCreated {
            meta: meta_from_row(&row),
            key,
        }),
    ))
}

pub async fn get_key(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<ApiKeyMeta>, (StatusCode, String)> {
    let row = load_key(&state.pool, auth.user_id, id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "api key not found".to_string()))?;
    Ok(Json(meta_from_row(&row)))
}

pub async fn update_key(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ApiKeyUpdate>,
) -> Result<Json<ApiKeyMeta>, (StatusCode, String)> {
    let row = sqlx::query_as::<_, ApiKeyRow>(
        r#"UPDATE api_keys
              SET name = COALESCE($3, name),
                  permissions = COALESCE($4, permissions)
            WHERE id = $1 AND user_id = $2
        RETURNING id, user_id, name, prefix, token_hash, permissions, created_at, last_used_at"#,
    )
    .bind(id)
    .bind(auth.user_id)
    .bind(body.name.as_deref())
    .bind(body.permissions.as_ref())
    .fetch_optional(&state.pool)
    .await
    .or_500()?;

    let row = row.ok_or_else(|| (StatusCode::NOT_FOUND, "api key not found".to_string()))?;
    Ok(Json(meta_from_row(&row)))
}

pub async fn delete_key(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let result = sqlx::query("DELETE FROM api_keys WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.user_id)
        .execute(&state.pool)
        .await
        .or_500()?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "api key not found".to_string()));
    }

    Ok(Json(json!({"ok": true, "message": "api key deleted"})))
}

pub async fn request_higher_limits(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<crate::models::HigherLimitsRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Ensure the key belongs to the caller.
    let _ = load_key(&state.pool, auth.user_id, id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "api key not found".to_string()))?;

    let justification = body.justification.trim();
    if justification.len() < 10 || justification.len() > 500 {
        return Err((StatusCode::BAD_REQUEST, "justification must be 10–500 characters".to_string()));
    }

    // For now, log the request into the audit log and return a "pending" message.
    // A future admin slice can add a review queue.
    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "api_key_higher_limits_requested",
        "api_key",
        &id.to_string(),
        json!({ "justification": justification }),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "request submitted for review"})))
}
