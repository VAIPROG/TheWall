//! GET /api/v3/clans/{id}     — fetch a single clan
//! PATCH /api/v3/clans/{id}   — update clan fields (lock-aware)

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ClanUpdate, ClanView},
    routes::v3::utils::permissions::{effective_clan_role, global_role_of},
};

use super::{build_clan_view, load_clan};

// ---------------------------------------------------------------------------
// GET /api/v3/clans/{id}
// ---------------------------------------------------------------------------

pub async fn get_clan(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<ClanView>, (StatusCode, String)> {
    let clan = load_clan(&state.pool, id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    let view = build_clan_view(&state.pool, Some(auth.user_id), clan).await?;
    Ok(Json(view))
}

// ---------------------------------------------------------------------------
// PATCH /api/v3/clans/{id}
// ---------------------------------------------------------------------------

pub async fn update_clan(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ClanUpdate>,
) -> Result<Json<ClanView>, (StatusCode, String)> {
    // ── load + auth ───────────────────────────────────────────────────────────
    let clan = load_clan(&state.pool, id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    let effective = effective_clan_role(&state.pool, auth.user_id, id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !effective.map(|r| r.is_admin()).unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, "clan admin required".to_string()));
    }

    // ── locked field check ────────────────────────────────────────────────────
    let locked_fields: Vec<String> = clan
        .moderation
        .get("lockedFields")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let caller_global = global_role_of(&state.pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let is_global_mod = caller_global.is_moderator();

    let field_lock_checks: &[(&str, bool, &str)] = &[
        ("avatar", body.avatar_url.is_some(), "avatarUrl"),
        ("banner", body.banner_url.is_some(), "bannerUrl"),
        ("description", body.description.is_some(), "description"),
        ("tag", body.tag.is_some(), "tag"),
        ("discoverable", body.discoverable.is_some(), "discoverable"),
    ];

    if !is_global_mod {
        for (lock_name, is_provided, display_name) in field_lock_checks {
            if *is_provided && locked_fields.contains(&lock_name.to_string()) {
                return Err((
                    StatusCode::from_u16(423).unwrap(),
                    format!("field '{}' is locked by global moderation", display_name),
                ));
            }
        }
    }

    // ── validate provided fields ──────────────────────────────────────────────
    if let Some(ref n) = body.name {
        let trimmed = n.trim();
        if trimmed.len() < 2 || trimmed.len() > 32 {
            return Err((StatusCode::BAD_REQUEST, "name must be 2\u{2013}32 characters".to_string()));
        }
    }
    if let Some(ref tag_val) = body.tag {
        if let Some(tag_str) = tag_val.as_str() {
            if tag_str.len() > 6 {
                return Err((StatusCode::BAD_REQUEST, "tag must be \u{2264}6 characters".to_string()));
            }
        }
    }

    // ── build dynamic UPDATE ──────────────────────────────────────────────────
    use sqlx::QueryBuilder;

    let mut qb: QueryBuilder<sqlx::Postgres> =
        QueryBuilder::new("UPDATE clans SET updated_at = NOW()");

    if let Some(ref n) = body.name {
        qb.push(", name = ");
        qb.push_bind(n.trim().to_string());
    }
    if let Some(ref desc) = body.description {
        qb.push(", description = ");
        qb.push_bind(desc.clone());
    }
    if let Some(ref av) = body.avatar_url {
        let v: Option<String> = av.as_str().map(|s| s.to_string());
        qb.push(", avatar_url = ");
        qb.push_bind(v);
    }
    if let Some(ref bv) = body.banner_url {
        let v: Option<String> = bv.as_str().map(|s| s.to_string());
        qb.push(", banner_url = ");
        qb.push_bind(v);
    }
    if let Some(ref tv) = body.tag {
        let v: Option<String> = tv.as_str().map(|s| s.to_string());
        qb.push(", tag = ");
        qb.push_bind(v);
    }
    if let Some(d) = body.discoverable {
        qb.push(", discoverable = ");
        qb.push_bind(d);
    }

    qb.push(" WHERE id = ");
    qb.push_bind(id);

    // Execute — handle unique violation on tag (23505 = unique_violation)
    let result = qb.build().execute(&state.pool).await;
    match result {
        Err(sqlx::Error::Database(db_err)) if db_err.code().as_deref() == Some("23505") => {
            return Err((StatusCode::CONFLICT, "tag taken".to_string()));
        }
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
        Ok(_) => {}
    }

    // ── reload + return ───────────────────────────────────────────────────────
    let updated = load_clan(&state.pool, id)
        .await?
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "clan vanished after update".to_string()))?;

    let view = build_clan_view(&state.pool, Some(auth.user_id), updated).await?;
    Ok(Json(view))
}
