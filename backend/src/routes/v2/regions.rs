//! Protected wall regions (/api/v2/regions).
//!
//! A region row is a captured "stable state" of a wall rect: reference pixels
//! (PNG data URL, clean tile composite), a tolerance (% of painted cells that
//! may change before alarm), and scope-based sharing identical to
//! anim_configs. The server-side guard loop (crate::region_guard) re-reads
//! live tiles on `check_interval` and updates last_ok / fires alerts; clients
//! can also verify locally and report via POST /{id}/report.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use crate::http_error::ResultExt;
use sqlx::FromRow;
use uuid::Uuid;

use super::permissions;
use crate::{AppState, auth::AuthUser};

/// 4 MB of base64 ≈ a ~1.7k×1.7k fully-painted region. Bigger than any
/// realistic protected artwork; small enough to keep rows manageable.
const MAX_REF_PNG_BYTES: usize = 4 * 1024 * 1024;
const MAX_REGIONS_PER_USER: i64 = 64;

#[derive(Debug, Serialize, FromRow)]
pub struct RegionRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub clan_id: Option<Uuid>,
    pub scope: String,
    /// Approval workflow: 'pending' | 'approved' | 'rejected'. Private
    /// regions are born approved; clan regions need a clan mod/admin,
    /// public (global) regions need a global admin.
    pub status: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub tolerance_pct: f32,
    pub captured_at: chrono::DateTime<chrono::Utc>,
    pub enabled: bool,
    pub check_interval: i32,
    pub last_checked_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_broken_pct: f32,
    pub last_ok: bool,
}

#[derive(Debug, Serialize, FromRow)]
pub struct RegionRowFull {
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub meta: RegionRow,
    pub ref_png: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub tolerance_pct: Option<f32>,
    pub ref_png: String,
    pub scope: Option<String>,
    pub clan_id: Option<Uuid>,
    pub check_interval: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub clan_id: Option<Uuid>,
}

fn validate_scope(scope: &str, clan_id: Option<Uuid>) -> Result<(), (StatusCode, String)> {
    match scope {
        "private" | "public" => Ok(()),
        "clan" if clan_id.is_some() => Ok(()),
        "clan" => Err((StatusCode::BAD_REQUEST, "clan scope needs clan_id".into())),
        _ => Err((StatusCode::BAD_REQUEST, "scope must be private|clan|public".into())),
    }
}

const REGION_COLS: &str = "id, user_id, clan_id, scope, status, name, x, y, w, h, tolerance_pct, \
     captured_at, enabled, check_interval, last_checked_at, last_broken_pct, last_ok";

/// Visible regions: own + clan-shared (active member) + public. No ref_png in
/// the list payload — fetch one by id when the client wants to re-verify.
pub async fn list(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<RegionRow>>, (StatusCode, String)> {
    // Others' shared regions surface only once approved; your own rows are
    // always visible (so you can watch your submission move through review).
    let rows = sqlx::query_as::<_, RegionRow>(&format!(
        r#"SELECT {REGION_COLS}
             FROM protected_regions
            WHERE (user_id = $1
                   OR ((scope = 'public'
                        OR (scope = 'clan' AND clan_id IN (
                             SELECT clan_id FROM clan_memberships
                              WHERE user_id = $1 AND active = TRUE)))
                       AND status = 'approved'))
              AND ($2::uuid IS NULL OR clan_id = $2)
            ORDER BY captured_at DESC
            LIMIT 200"#,
    ))
    .bind(auth.user_id)
    .bind(q.clan_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;
    Ok(Json(rows))
}

/// One region with its reference pixels (for client-side verification).
pub async fn get_one(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<RegionRowFull>, (StatusCode, String)> {
    let row = sqlx::query_as::<_, RegionRowFull>(&format!(
        r#"SELECT {REGION_COLS}, ref_png
             FROM protected_regions
            WHERE id = $2
              AND (user_id = $1
                   OR ((scope = 'public'
                        OR (scope = 'clan' AND clan_id IN (
                             SELECT clan_id FROM clan_memberships
                              WHERE user_id = $1 AND active = TRUE)))
                       AND status = 'approved'))"#,
    ))
    .bind(auth.user_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?
    .ok_or((StatusCode::NOT_FOUND, "not found".into()))?;
    Ok(Json(row))
}

pub async fn create(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(b): Json<CreateBody>,
) -> Result<Json<RegionRow>, (StatusCode, String)> {
    if b.name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name required".into()));
    }
    if b.w <= 0 || b.h <= 0 || b.w > 6000 || b.h > 4200 {
        return Err((StatusCode::BAD_REQUEST, "bad region size".into()));
    }
    if !b.ref_png.starts_with("data:image/png;base64,") {
        return Err((StatusCode::BAD_REQUEST, "ref_png must be a PNG data URL".into()));
    }
    if b.ref_png.len() > MAX_REF_PNG_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "ref_png too large".into()));
    }
    let scope = b.scope.as_deref().unwrap_or("private");
    validate_scope(scope, b.clan_id)?;
    // Clan publishers must be members; the shared bypass then decides whether
    // the publish lands pre-approved (global admin / VAI / clan mod) or
    // 'pending' for review. Private regions are always auto-approved.
    if scope == "clan" {
        let role = permissions::effective_clan_role(&state.pool, auth.user_id, b.clan_id.unwrap())
            .await
            .or_500()?;
        if role.is_none() {
            return Err((StatusCode::FORBIDDEN, "not a member of that clan".into()));
        }
    }
    let status = if scope == "private"
        || permissions::publish_auto_approved(&state.pool, auth.user_id, scope, b.clan_id)
            .await
            .or_500()?
    {
        "approved"
    } else {
        "pending"
    };
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM protected_regions WHERE user_id = $1")
        .bind(auth.user_id)
        .fetch_one(&state.pool)
        .await
        .or_500()?;
    if count >= MAX_REGIONS_PER_USER {
        return Err((StatusCode::TOO_MANY_REQUESTS, "region limit reached".into()));
    }

    let interval = b.check_interval.unwrap_or(120).clamp(60, 24 * 3600);
    let tol = b.tolerance_pct.unwrap_or(0.0).clamp(0.0, 100.0);
    let row = sqlx::query_as::<_, RegionRow>(&format!(
        r#"INSERT INTO protected_regions
                (user_id, clan_id, scope, status, name, x, y, w, h, tolerance_pct, ref_png, check_interval)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING {REGION_COLS}"#,
    ))
    .bind(auth.user_id)
    .bind(if scope == "clan" { b.clan_id } else { None })
    .bind(scope)
    .bind(status)
    .bind(b.name.trim())
    .bind(b.x)
    .bind(b.y)
    .bind(b.w)
    .bind(b.h)
    .bind(tol)
    .bind(&b.ref_png)
    .bind(interval)
    .fetch_one(&state.pool)
    .await
    .or_500()?;
    Ok(Json(row))
}

/* --------------------------- approval workflow --------------------------- */

/// Approve or reject a shared region. Clan-scoped → clan moderator/admin of
/// that clan; public (global) → global admin. Private regions never need it.
async fn set_status(
    auth: AuthUser,
    state: &AppState,
    id: Uuid,
    new_status: &str,
) -> Result<Json<RegionRow>, (StatusCode, String)> {
    let existing: Option<(String, Option<Uuid>)> =
        sqlx::query_as("SELECT scope, clan_id FROM protected_regions WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .or_500()?;
    let (scope, clan) = existing.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;

    let allowed = match scope.as_str() {
        "clan" => {
            let Some(cid) = clan else {
                return Err((StatusCode::INTERNAL_SERVER_ERROR, "clan region without clan_id".into()));
            };
            let role = permissions::effective_clan_role(&state.pool, auth.user_id, cid)
                .await
                .or_500()?;
            role.map(|r| r.is_mod()).unwrap_or(false)
                || permissions::global_role_of(&state.pool, auth.user_id)
                    .await
                    .or_500()?
                    .is_admin()
        }
        "public" => permissions::global_role_of(&state.pool, auth.user_id)
            .await
            .or_500()?
            .is_admin(),
        _ => return Err((StatusCode::BAD_REQUEST, "private regions need no approval".into())),
    };
    if !allowed {
        return Err((StatusCode::FORBIDDEN, "approver role required".into()));
    }

    let row = sqlx::query_as::<_, RegionRow>(&format!(
        "UPDATE protected_regions SET status = $2 WHERE id = $1 RETURNING {REGION_COLS}",
    ))
    .bind(id)
    .bind(new_status)
    .fetch_one(&state.pool)
    .await
    .or_500()?;
    Ok(Json(row))
}

pub async fn approve(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<RegionRow>, (StatusCode, String)> {
    set_status(auth, &state, id, "approved").await
}

pub async fn reject(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<RegionRow>, (StatusCode, String)> {
    set_status(auth, &state, id, "rejected").await
}

/// Mutation rights: the publisher (owner), a global admin, or — for
/// clan-scoped regions — a clan ADMIN of that clan. Clan moderators can see
/// and verify but deliberately can't re-fix or delete someone's reference:
/// a wrongly re-captured reference silently legitimises grief, so the bar
/// for touching it is the clan's admin tier.
async fn can_mutate(
    state: &AppState,
    auth: &AuthUser,
    row_owner: Uuid,
    row_clan: Option<Uuid>,
) -> Result<bool, (StatusCode, String)> {
    if row_owner == auth.user_id {
        return Ok(true);
    }
    let g = permissions::global_role_of(&state.pool, auth.user_id)
        .await
        .or_500()?;
    if g.is_admin() {
        return Ok(true);
    }
    if let Some(cid) = row_clan {
        let role = permissions::effective_clan_role(&state.pool, auth.user_id, cid)
            .await
            .or_500()?;
        return Ok(role.map(|r| r.is_admin()).unwrap_or(false));
    }
    Ok(false)
}

#[derive(Debug, Deserialize)]
pub struct UpdateBody {
    pub name: Option<String>,
    pub tolerance_pct: Option<f32>,
    pub enabled: Option<bool>,
    pub scope: Option<String>,
    pub clan_id: Option<Uuid>,
    pub check_interval: Option<i32>,
    /// Re-fix: replace the reference with a fresh capture.
    pub ref_png: Option<String>,
}

pub async fn update(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(b): Json<UpdateBody>,
) -> Result<Json<RegionRow>, (StatusCode, String)> {
    let existing: Option<(Uuid, Option<Uuid>)> =
        sqlx::query_as("SELECT user_id, clan_id FROM protected_regions WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .or_500()?;
    let (owner, clan) = existing.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;
    if !can_mutate(&state, &auth, owner, clan).await? {
        return Err((StatusCode::FORBIDDEN, "owner / clan admin required".into()));
    }
    if let Some(p) = &b.ref_png {
        if !p.starts_with("data:image/png;base64,") || p.len() > MAX_REF_PNG_BYTES {
            return Err((StatusCode::BAD_REQUEST, "bad ref_png".into()));
        }
    }
    if let Some(scope) = &b.scope {
        validate_scope(scope, b.clan_id.or(clan))?;
    }
    let row = sqlx::query_as::<_, RegionRow>(&format!(
        r#"UPDATE protected_regions SET
               name           = COALESCE($2, name),
               tolerance_pct  = COALESCE($3, tolerance_pct),
               enabled        = COALESCE($4, enabled),
               scope          = COALESCE($5, scope),
               clan_id        = COALESCE($6, clan_id),
               check_interval = COALESCE($7, check_interval),
               ref_png        = COALESCE($8, ref_png),
               captured_at    = CASE WHEN $8 IS NULL THEN captured_at ELSE now() END,
               last_ok        = CASE WHEN $8 IS NULL THEN last_ok ELSE TRUE END
           WHERE id = $1
           RETURNING {REGION_COLS}"#,
    ))
    .bind(id)
    .bind(b.name.as_deref().map(str::trim))
    .bind(b.tolerance_pct.map(|t| t.clamp(0.0, 100.0)))
    .bind(b.enabled)
    .bind(&b.scope)
    .bind(b.clan_id)
    .bind(b.check_interval.map(|i| i.clamp(60, 24 * 3600)))
    .bind(&b.ref_png)
    .fetch_one(&state.pool)
    .await
    .or_500()?;
    Ok(Json(row))
}

pub async fn remove(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let existing: Option<(Uuid, Option<Uuid>)> =
        sqlx::query_as("SELECT user_id, clan_id FROM protected_regions WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .or_500()?;
    let (owner, clan) = existing.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;
    if !can_mutate(&state, &auth, owner, clan).await? {
        return Err((StatusCode::FORBIDDEN, "owner / clan admin required".into()));
    }
    sqlx::query("DELETE FROM protected_regions WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .or_500()?;
    Ok(StatusCode::NO_CONTENT)
}

/* --------------------------- client report ------------------------------ */

#[derive(Debug, Deserialize)]
pub struct ReportBody {
    pub broken_pct: f32,
    pub ok: bool,
}

/// A client that verified locally can push its verdict; the guard loop is the
/// authoritative checker, but client reports give instant feedback between
/// guard passes (the guard will overwrite on its next pass).
pub async fn report(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(b): Json<ReportBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Reporter must be able to SEE the region.
    let visible: Option<(Uuid,)> = sqlx::query_as(
        r#"SELECT id FROM protected_regions
            WHERE id = $2
              AND (user_id = $1
                   OR scope = 'public'
                   OR (scope = 'clan' AND clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $1 AND active = TRUE)))"#,
    )
    .bind(auth.user_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;
    if visible.is_none() {
        return Err((StatusCode::NOT_FOUND, "not found".into()));
    }
    sqlx::query(
        r#"UPDATE protected_regions
              SET last_checked_at = now(),
                  last_broken_pct = $2,
                  last_ok = $3
            WHERE id = $1"#,
    )
    .bind(id)
    .bind(b.broken_pct.clamp(0.0, 100.0))
    .bind(b.ok)
    .execute(&state.pool)
    .await
    .or_500()?;
    Ok(StatusCode::NO_CONTENT)
}
