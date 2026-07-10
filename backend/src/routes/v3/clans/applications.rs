//! GET  /api/v3/clans/{id}/applications                — list pending join applications (mod+)
//! POST /api/v3/clans/{cid}/applications/{aid}/review  — approve or reject (mod+)

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ApplicationReview, ClanJoinApplicationApplicant, ClanJoinApplicationView},
    routes::v3::utils::permissions::effective_clan_role,
};

use super::load_clan;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Columns returned by the application SELECT:
/// id, clan_id, applicant_id, username, display_name, avatar_url,
/// message, status, created_at, reviewed_by, reviewed_at
type AppRow = (
    Uuid,           // 0  id
    Uuid,           // 1  clan_id
    Uuid,           // 2  applicant_id
    String,         // 3  username
    Option<String>, // 4  display_name
    Option<String>, // 5  avatar_url
    Option<String>, // 6  message
    String,         // 7  status
    DateTime<Utc>,  // 8  created_at
    Option<Uuid>,   // 9  reviewed_by
    Option<DateTime<Utc>>, // 10 reviewed_at
);

fn row_to_view(r: AppRow) -> ClanJoinApplicationView {
    let display_name = r.4.filter(|s| !s.is_empty()).unwrap_or_else(|| r.3.clone());
    ClanJoinApplicationView {
        id: r.0,
        clan_id: r.1,
        applicant: ClanJoinApplicationApplicant {
            user_id: r.2,
            username: r.3,
            display_name,
            avatar_url: r.5,
        },
        message: r.6,
        status: r.7,
        created_at: r.8,
        reviewed_by: r.9,
        reviewed_at: r.10,
    }
}

const APP_SELECT: &str = r#"SELECT a.id, a.clan_id, a.applicant_id,
          u.username, u.display_name, av.image,
          a.message, a.status, a.created_at, a.reviewed_by, a.reviewed_at
   FROM clan_join_applications a
   JOIN users u ON u.id = a.applicant_id
   LEFT JOIN avatars av ON av.user_id = a.applicant_id"#;

// ---------------------------------------------------------------------------
// GET /api/v3/clans/{id}/applications
// ---------------------------------------------------------------------------

pub async fn list_applications(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
) -> Result<Json<Vec<ClanJoinApplicationView>>, (StatusCode, String)> {
    let _clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    let actor_role = effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !actor_role.map(|r| r.is_moderator()).unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, "clan moderator required".to_string()));
    }

    let query = format!("{} WHERE a.clan_id = $1 AND a.status = 'pending' ORDER BY a.created_at DESC", APP_SELECT);

    let rows: Vec<AppRow> = sqlx::query_as(&query)
        .bind(clan_id)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows.into_iter().map(row_to_view).collect()))
}

// ---------------------------------------------------------------------------
// POST /api/v3/clans/{cid}/applications/{aid}/review
// ---------------------------------------------------------------------------

pub async fn review_application(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((clan_id, app_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ApplicationReview>,
) -> Result<Json<ClanJoinApplicationView>, (StatusCode, String)> {
    let _clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    let actor_role = effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !actor_role.map(|r| r.is_moderator()).unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, "clan moderator required".to_string()));
    }

    // Validate decision
    if body.decision != "approve" && body.decision != "reject" {
        return Err((StatusCode::BAD_REQUEST, "decision must be 'approve' or 'reject'".to_string()));
    }

    // Load the application — must belong to this clan
    let app: Option<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT id, applicant_id, status FROM clan_join_applications WHERE id = $1 AND clan_id = $2",
    )
    .bind(app_id)
    .bind(clan_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let (_, applicant_id, status) = app
        .ok_or_else(|| (StatusCode::NOT_FOUND, "application not found".to_string()))?;

    if status != "pending" {
        return Err((StatusCode::CONFLICT, "application is not pending".to_string()));
    }

    let now = chrono::Utc::now();
    let new_status = if body.decision == "approve" { "approved" } else { "rejected" };

    // If approving, upsert membership
    if body.decision == "approve" {
        sqlx::query(
            r#"INSERT INTO clan_memberships (id, user_id, clan_id, clan_role, active)
               VALUES (gen_random_uuid(), $1, $2, 'member', TRUE)
               ON CONFLICT (user_id, clan_id) DO UPDATE SET active = TRUE, clan_role = 'member'"#,
        )
        .bind(applicant_id)
        .bind(clan_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    // Update application status
    sqlx::query(
        r#"UPDATE clan_join_applications
           SET status = $1, reviewed_by = $2, reviewed_at = $3
           WHERE id = $4"#,
    )
    .bind(new_status)
    .bind(auth.user_id)
    .bind(now)
    .bind(app_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Reload and return
    let reload_query = format!("{} WHERE a.id = $1", APP_SELECT);
    let row: AppRow = sqlx::query_as(&reload_query)
        .bind(app_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(row_to_view(row)))
}
