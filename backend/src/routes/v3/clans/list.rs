//! GET /api/v3/clans
//!
//! Returns a paginated list of discoverable clans (or all clans for global mods+).
//! Supports search by name (ILIKE), sort by name/memberCount/createdAt/activity,
//! and asc/desc ordering.

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};

use crate::{
    AppState,
    auth::AuthUser,
    models::{ClanListQuery, ClanPage, ClanV3},
    routes::v3::utils::permissions::global_role_of,
};

use super::build_clan_view;

pub async fn list_clans(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ClanListQuery>,
) -> Result<Json<ClanPage>, (StatusCode, String)> {
    // ── pagination bounds ─────────────────────────────────────────────────────
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(20).clamp(1, 100);
    let offset = (page - 1) * per_page;

    // ── visibility: global mod+ sees non-discoverable too ────────────────────
    let caller_role = global_role_of(&state.pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let see_all = caller_role.is_moderator();

    // ── sort clause ───────────────────────────────────────────────────────────
    let order_dir = match q.order.as_deref() {
        Some("asc") => "ASC",
        _ => "DESC",
    };
    let order_clause = match q.sort_by.as_deref() {
        Some("name") => format!("c.name {}", order_dir),
        Some("memberCount") => format!(
            "(SELECT COUNT(*) FROM clan_memberships cm WHERE cm.clan_id = c.id AND cm.active = TRUE) {}",
            order_dir
        ),
        Some("activity") => "c.updated_at DESC".to_string(),
        _ => format!("c.created_at {}", order_dir),
    };

    // ── build WHERE fragments ─────────────────────────────────────────────────
    let search_pattern = q.search.as_deref().map(|s| format!("%{}%", s));

    let (rows, total): (Vec<ClanV3>, i64) = if let Some(ref pattern) = search_pattern {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM clans c WHERE ($1 OR c.discoverable = TRUE) AND c.name ILIKE $2",
        )
        .bind(see_all)
        .bind(pattern)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let rows = sqlx::query_as::<_, ClanV3>(&format!(
            r#"SELECT c.id, c.source, c.external_id, c.name, c.display_name, c.discord_id,
                      c.icon, c.stats, c.created_at, c.updated_at,
                      c.avatar_url, c.banner_url, c.description, c.tag, c.verified,
                      c.discoverable, c.lang, c.max_members, c.owner_id, c.join_policy,
                      c.settings, c.moderation
               FROM clans c
               WHERE ($1 OR c.discoverable = TRUE)
                 AND c.name ILIKE $2
               ORDER BY {order_clause}
               LIMIT $3 OFFSET $4"#
        ))
        .bind(see_all)
        .bind(pattern)
        .bind(per_page)
        .bind(offset)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        (rows, count)
    } else {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM clans c WHERE ($1 OR c.discoverable = TRUE)",
        )
        .bind(see_all)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let rows = sqlx::query_as::<_, ClanV3>(&format!(
            r#"SELECT c.id, c.source, c.external_id, c.name, c.display_name, c.discord_id,
                      c.icon, c.stats, c.created_at, c.updated_at,
                      c.avatar_url, c.banner_url, c.description, c.tag, c.verified,
                      c.discoverable, c.lang, c.max_members, c.owner_id, c.join_policy,
                      c.settings, c.moderation
               FROM clans c
               WHERE ($1 OR c.discoverable = TRUE)
               ORDER BY {order_clause}
               LIMIT $2 OFFSET $3"#
        ))
        .bind(see_all)
        .bind(per_page)
        .bind(offset)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        (rows, count)
    };

    // ── build views ───────────────────────────────────────────────────────────
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let view = build_clan_view(&state.pool, Some(auth.user_id), row).await?;
        items.push(view);
    }

    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    Ok(Json(ClanPage {
        items,
        page,
        per_page,
        total,
        total_pages,
    }))
}
