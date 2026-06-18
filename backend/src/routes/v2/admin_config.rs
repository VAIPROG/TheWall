//! Admin handlers for server_config: list all entries and update a single value.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use super::permissions;
use crate::{AppState, auth::AuthUser};

#[derive(Debug, Serialize, FromRow)]
pub struct ConfigRow {
    pub key: String,
    pub value: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConfigBody {
    pub value: String,
}

pub async fn list_config(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<ConfigRow>>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    let rows = sqlx::query_as::<_, ConfigRow>(
        "SELECT key, value, updated_at FROM server_config ORDER BY key",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

pub async fn update_config(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<UpdateConfigBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    let result =
        sqlx::query(
            "UPDATE server_config SET value = $1, updated_at = NOW() WHERE key = $2",
        )
        .bind(&body.value)
        .bind(&key)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, format!("config key '{}' not found", key)));
    }
    Ok(StatusCode::OK)
}
