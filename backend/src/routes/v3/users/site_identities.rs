use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
};

use crate::{
    AppState,
    auth::AuthUser,
    models::SiteIdentity,
};

// ---------------------------------------------------------------------------
// GET /api/v3/users/me/site-identities  (auth required)
//
// Returns every site_identities row for the authenticated account, ordered by
// when the identity was first linked.
// ---------------------------------------------------------------------------

pub async fn list_site_identities(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<SiteIdentity>>, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, SiteIdentity>(
        "SELECT * FROM site_identities WHERE account_id = $1 ORDER BY linked_at",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows))
}

// ---------------------------------------------------------------------------
// DELETE /api/v3/users/me/site-identities/{source}  (auth required)
//
// Unlinks the named site identity from the authenticated account.
//
// Last-factor guard: refuses to remove the identity if it is the account's
// only remaining login method (total factors = site_identities + provider_links
// ≤ 1). This prevents permanent lock-out.
// ---------------------------------------------------------------------------

pub async fn unlink_site_identity(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(source): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Count total login factors for this account.
    let site_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM site_identities WHERE account_id = $1",
    )
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let provider_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_links WHERE account_id = $1",
    )
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if site_count + provider_count <= 1 {
        return Err((
            StatusCode::CONFLICT,
            "cannot unlink your last login method".to_string(),
        ));
    }

    let result = sqlx::query(
        "DELETE FROM site_identities WHERE account_id = $1 AND source = $2",
    )
    .bind(auth.user_id)
    .bind(&source)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "site identity not found".to_string()));
    }

    Ok(StatusCode::NO_CONTENT)
}
