use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ReportRequest, ShareTemplateRequest, Template},
};

const TEMPLATE_SCALE_MIN: f64 = 0.01;
const TEMPLATE_SCALE_MAX: f64 = 10000.0;

pub(crate) fn validate_template_scale(scale: f64) -> Result<f64, (StatusCode, &'static str)> {
    if scale.is_finite() && (TEMPLATE_SCALE_MIN..=TEMPLATE_SCALE_MAX).contains(&scale) {
        Ok(scale)
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            "scale must be between 0.01 and 10000",
        ))
    }
}

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct PublicTemplatesQuery {
    pub status: Option<String>,
}


// ---------------------------------------------------------------------------
// POST /  (requires auth)
// ---------------------------------------------------------------------------

pub async fn create(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<ShareTemplateRequest>,
) -> impl IntoResponse {
    // Fetch the user's username + both legacy `role` and v2 `global_role` so
    // we can compute auto-approval correctly even on dual-running systems.
    let user_row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT username, COALESCE(role, 'user'), COALESCE(global_role, 'user') FROM users WHERE id = $1",
    )
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await;

    let (username, legacy_role, global_role) = match user_row {
        Ok(u) => u,
        Err(e) => {
            tracing::error!("create template: user lookup error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response();
        }
    };

    let is_global_admin = matches!(global_role.as_str(), "owner" | "admin")
        || matches!(legacy_role.as_str(), "owner" | "admin");

    // For clan-scope templates we also need the caller's clan and clan-level
    // role for auto-approval (moderator/admin auto-approve their own clan).
    let clan_id_for_template: Option<Uuid> = if body.scope == "clan" {
        sqlx::query_scalar(
            r#"SELECT clan_id FROM clan_memberships
                WHERE user_id = $1 AND active = true
                ORDER BY joined_at ASC
                LIMIT 1"#,
        )
        .bind(auth.user_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
    } else {
        None
    };
    let is_clan_mod: bool = if let Some(cid) = clan_id_for_template {
        sqlx::query_scalar::<_, String>(
            r#"SELECT clan_role FROM clan_memberships
                WHERE user_id = $1 AND clan_id = $2 AND active = true"#,
        )
        .bind(auth.user_id)
        .bind(cid)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
        .map(|r| matches!(r.as_str(), "admin" | "moderator"))
        .unwrap_or(false)
    } else {
        false
    };

    // Approval matrix:
    //   global admin/owner → approved (any scope)
    //   scope='clan' & clan mod → approved
    //   otherwise → pending (public goes to review queue;
    //              clan-scope just sits in pending too)
    let status: &str = if is_global_admin {
        "approved"
    } else if body.scope == "clan" && is_clan_mod {
        "approved"
    } else {
        "pending"
    };

    let scale = match validate_template_scale(body.scale.unwrap_or(1.0)) {
        Ok(scale) => scale,
        Err(e) => return e.into_response(),
    };
    let id = Uuid::new_v4();

    let result = sqlx::query_as::<_, Template>(
        r#"
        INSERT INTO templates (id, user_id, name, x, y, scale, scope, status, share, author, clan_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(auth.user_id)
    .bind(&body.name)
    .bind(body.x)
    .bind(body.y)
    .bind(scale)
    .bind(&body.scope)
    .bind(status)
    .bind(&body.share)
    .bind(&username)
    .bind(clan_id_for_template)
    .fetch_one(&state.pool)
    .await;

    match result {
        Ok(template) => (StatusCode::CREATED, Json(template)).into_response(),
        Err(e) => {
            tracing::error!("create template error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// GET /public?status=approved|pending  (public, no auth required)
// ---------------------------------------------------------------------------

pub async fn list_public(
    State(state): State<AppState>,
    Query(params): Query<PublicTemplatesQuery>,
) -> impl IntoResponse {
    let status = params.status.unwrap_or_else(|| "approved".to_string());

    let rows = sqlx::query_as::<_, Template>(
        "SELECT * FROM templates WHERE scope = 'public' AND status = $1 ORDER BY created_at DESC",
    )
    .bind(&status)
    .fetch_all(&state.pool)
    .await;

    match rows {
        Ok(templates) => (StatusCode::OK, Json(templates)).into_response(),
        Err(e) => {
            tracing::error!("list_public error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// POST /:id/report  (requires auth)
// ---------------------------------------------------------------------------

pub async fn report(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ReportRequest>,
) -> impl IntoResponse {
    let result = sqlx::query(
        r#"
        INSERT INTO template_reports (id, template_id, user_id, reason, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(id)
    .bind(auth.user_id)
    .bind(&body.reason)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => StatusCode::CREATED.into_response(),
        Err(e) => {
            tracing::error!("report template error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// POST /:id/approve  (requires auth + role check)
// ---------------------------------------------------------------------------

pub async fn delete_template(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    let role_row = sqlx::query_scalar::<_, String>("SELECT role FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_one(&state.pool)
        .await;
    let role = match role_row {
        Ok(r) => r,
        Err(_) => return StatusCode::UNAUTHORIZED.into_response(),
    };
    let owner_row = sqlx::query_scalar::<_, Uuid>("SELECT user_id FROM templates WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    let is_owner = owner_row == Some(auth.user_id);
    let privileged = matches!(role.as_str(), "owner" | "moderator" | "admin");
    if !is_owner && !privileged {
        return StatusCode::FORBIDDEN.into_response();
    }
    sqlx::query("DELETE FROM template_reports WHERE template_id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .ok();
    let r = sqlx::query("DELETE FROM templates WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await;
    match r {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            tracing::error!("delete_template error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()
        }
    }
}

pub async fn approve(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    // Check that the requesting user has a privileged role.
    let role_row = sqlx::query_scalar::<_, String>("SELECT role FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_one(&state.pool)
        .await;

    let role = match role_row {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("approve template: role lookup error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response();
        }
    };

    if !matches!(role.as_str(), "owner" | "moderator" | "admin") {
        return (StatusCode::FORBIDDEN, "Insufficient permissions").into_response();
    }

    let result = sqlx::query("UPDATE templates SET status = 'approved' WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("approve template error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response()
        }
    }
}
