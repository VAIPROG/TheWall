//! V2 templates: unified list with filtering, deletion, approval workflow,
//! pin slots, and mailbox events on status changes.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthUser, hash_token, verify_token},
};

use super::permissions;
use crate::routes::templates::validate_template_scale;

#[derive(Debug, Serialize, FromRow)]
pub struct TemplateV2 {
    pub id: Uuid,
    pub user_id: Uuid,
    pub author: Option<String>,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub scope: String,
    pub status: String,
    pub share: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub scope: Option<String>,
    pub status: Option<String>,
    pub author: Option<Uuid>,
    pub limit: Option<i64>,
    pub cursor: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn list(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<TemplateV2>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(50).min(200);
    // SECURITY: clan-scope templates must be filtered by the caller's active
    // clan memberships. Public templates are visible to anyone authed.
    let rows = sqlx::query_as::<_, TemplateV2>(
        r#"SELECT id, user_id, author, name, x, y, scale, scope, status, share, created_at
             FROM templates
            WHERE ($1::text IS NULL OR scope = $1)
              AND ($2::text IS NULL OR status = $2)
              AND ($3::uuid IS NULL OR user_id = $3)
              AND ($4::timestamptz IS NULL OR created_at < $4)
              AND (
                  scope = 'public'
                  OR user_id = $6
                  OR clan_id IN (
                      SELECT clan_id FROM clan_memberships
                       WHERE user_id = $6 AND active = true
                  )
              )
            ORDER BY created_at DESC
            LIMIT $5"#,
    )
    .bind(q.scope.as_deref())
    .bind(q.status.as_deref())
    .bind(q.author)
    .bind(q.cursor)
    .bind(limit)
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct SharedQuery {
    pub pass: Option<String>,
}

/// GET /api/v2/templates/{id}/shared — fetch one classic template through a
/// share code. Mirrors the animated-config endpoint (anim.rs::shared):
///   1. correct `?pass=` → granted, even for private templates, no auth;
///   2. otherwise a valid session that passes the normal visibility rules
///      (owner / approved public / caller's clan).
/// Auth is OPTIONAL by design, so the Bearer token is parsed by hand.
pub async fn shared(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<SharedQuery>,
    headers: HeaderMap,
) -> Result<Json<TemplateV2>, (StatusCode, String)> {
    const COLS: &str =
        "id, user_id, author, name, x, y, scale, scope, status, share, created_at";

    // Path 1: password.
    if let Some(pass) = q.pass.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        let row = sqlx::query_as::<_, TemplateV2>(&format!(
            "SELECT {COLS} FROM templates WHERE id = $1 AND access_password_hash = $2",
        ))
        .bind(id)
        .bind(hash_token(pass))
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if let Some(row) = row {
            return Ok(Json(row));
        }
        // Wrong password falls through to the session path — a logged-in
        // owner with a stale link still wins.
    }

    // Path 2: session.
    let user_id = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .and_then(|tok| verify_token(tok, &state.config.jwt_secret).ok())
        .and_then(|c| Uuid::parse_str(&c.sub).ok());
    let Some(user_id) = user_id else {
        return Err((StatusCode::NOT_FOUND, "not found".into()));
    };
    let row = sqlx::query_as::<_, TemplateV2>(&format!(
        r#"SELECT {COLS} FROM templates
            WHERE id = $2
              AND (user_id = $1
                   OR (scope = 'public' AND status = 'approved')
                   OR (scope = 'clan' AND clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $1 AND active = TRUE)))"#,
    ))
    .bind(user_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    row.map(Json)
        .ok_or((StatusCode::NOT_FOUND, "not found".into()))
}

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub scale: Option<f64>,
    pub scope: String,
    pub share: String,
    /// Optional: clan id for scope='clan'. If absent and scope='clan', we use
    /// the caller's first active membership.
    pub clan_id: Option<Uuid>,
    /// Optional share password: anyone holding the template id AND this
    /// password can fetch the row via GET /{id}/shared — even scope='private'.
    pub access_password: Option<String>,
}

pub async fn create(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<CreateRequest>,
) -> Result<Json<TemplateV2>, (StatusCode, String)> {
    let user_row: (String, String) =
        sqlx::query_as("SELECT username, global_role FROM users WHERE id = $1")
            .bind(auth.user_id)
            .fetch_one(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (username, global_role) = user_row;
    if !matches!(body.scope.as_str(), "private" | "clan" | "public") {
        return Err((
            StatusCode::BAD_REQUEST,
            "scope must be private|clan|public".to_string(),
        ));
    }
    let is_global_admin = permissions::GlobalRole::from_str(&global_role).is_admin();
    let is_admin = is_global_admin;

    // SECURITY: a 'clan' scope template MUST be tagged with a clan_id; the
    // body field is optional, so for that case fall back to the caller's
    // first active membership. Public templates carry NULL clan_id.
    let clan_id: Option<Uuid> = if body.scope == "clan" {
        let resolved = if let Some(c) = body.clan_id {
            Some(c)
        } else {
            sqlx::query_scalar(
                r#"SELECT clan_id FROM clan_memberships
                    WHERE user_id = $1 AND active = true
                    ORDER BY joined_at ASC
                    LIMIT 1"#,
            )
            .bind(auth.user_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        };
        let cid = resolved.ok_or_else(|| {
            (
                StatusCode::FORBIDDEN,
                "clan scope requires the caller to be a clan member".to_string(),
            )
        })?;
        // Make sure the caller is actually a member of the clan they're posting to.
        let member: Option<bool> = sqlx::query_scalar(
            r#"SELECT TRUE FROM clan_memberships
                WHERE user_id = $1 AND clan_id = $2 AND active = true"#,
        )
        .bind(auth.user_id)
        .bind(cid)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if member.is_none() && !is_admin {
            return Err((
                StatusCode::FORBIDDEN,
                "You are not a member of that clan".to_string(),
            ));
        }
        Some(cid)
    } else {
        None
    };

    // Auto-approval bypass (global admin / VAI / clan mod) — shared with
    // animated configs and protected regions, see permissions.rs.
    let auto_approve = body.scope == "private" // owner-only — nothing to moderate
        || permissions::publish_auto_approved(&state.pool, auth.user_id, &body.scope, clan_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let status = if auto_approve { "approved" } else { "pending" };

    let scale = validate_template_scale(body.scale.unwrap_or(1.0))
        .map_err(|(status, msg)| (status, msg.to_string()))?;

    let pass_hash = body
        .access_password
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(hash_token);

    let row = sqlx::query_as::<_, TemplateV2>(
        r#"INSERT INTO templates (id, user_id, name, x, y, scale, scope, status, share, author, clan_id, access_password_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
           RETURNING id, user_id, author, name, x, y, scale, scope, status, share, created_at"#,
    )
    .bind(Uuid::new_v4())
    .bind(auth.user_id)
    .bind(&body.name)
    .bind(body.x).bind(body.y)
    .bind(scale)
    .bind(&body.scope)
    .bind(status)
    .bind(&body.share)
    .bind(&username)
    .bind(clan_id)
    .bind(pass_hash)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(row))
}

pub async fn approve(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let g = permissions::global_role_of(&state.pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !g.is_admin() {
        // Clan templates: caller must be at least clan_mod in the template's
        // scope. For simplicity we use the clan-templates-only check.
        let scope: Option<String> = sqlx::query_scalar("SELECT scope FROM templates WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if scope.as_deref() != Some("public") {
            return Err((
                StatusCode::FORBIDDEN,
                "only admins approve cross-clan content".into(),
            ));
        }
        return Err((StatusCode::FORBIDDEN, "admin required".into()));
    }

    let owner: Option<Uuid> = sqlx::query_scalar(
        "UPDATE templates SET status = 'approved' WHERE id = $1 RETURNING user_id",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(uid) = owner {
        // Mailbox event: template approved.
        sqlx::query(
            r#"INSERT INTO mailbox_items (id, kind, sender_id, recipient_user_id, title, body, payload)
               VALUES (gen_random_uuid(), 'template_event', $1, $2,
                       'Template approved', 'Your template was approved.',
                       jsonb_build_object('template_id', $3::text, 'event', 'approved'))"#,
        )
        .bind(auth.user_id).bind(uid).bind(id).execute(&state.pool).await.ok();
    }
    Ok(StatusCode::OK)
}

pub async fn reject(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    let owner: Option<Uuid> = sqlx::query_scalar(
        "UPDATE templates SET status = 'rejected' WHERE id = $1 RETURNING user_id",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(uid) = owner {
        sqlx::query(
            r#"INSERT INTO mailbox_items (id, kind, sender_id, recipient_user_id, title, body, payload)
               VALUES (gen_random_uuid(), 'template_event', $1, $2,
                       'Template rejected', 'Your template was rejected.',
                       jsonb_build_object('template_id', $3::text, 'event', 'rejected'))"#,
        )
        .bind(auth.user_id).bind(uid).bind(id).execute(&state.pool).await.ok();
    }
    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize)]
pub struct PinRequest {
    pub slot: i32,
}

pub async fn pin(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(b): Json<PinRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !(1..=3).contains(&b.slot) {
        return Err((StatusCode::BAD_REQUEST, "slot must be 1, 2 or 3".into()));
    }
    sqlx::query(
        r#"INSERT INTO pinned_templates (user_id, template_id, slot)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, slot) DO UPDATE SET template_id = EXCLUDED.template_id, pinned_at = NOW()"#,
    )
    .bind(auth.user_id).bind(id).bind(b.slot)
    .execute(&state.pool).await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

pub async fn unpin(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    sqlx::query("DELETE FROM pinned_templates WHERE user_id = $1 AND template_id = $2")
        .bind(auth.user_id)
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}
