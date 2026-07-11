//! V2 auth surface: a richer GET /me that bundles the user's clan
//! memberships, global role, profile extras and bio/social links into a
//! single response. Clients use this to drive their entire permission UI.

use axum::{Json, extract::State, http::StatusCode};
use crate::http_error::ResultExt;
use serde::Serialize;
use sqlx::FromRow;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};

#[derive(Debug, Serialize, FromRow)]
pub struct ClanMembershipView {
    pub clan_id: Uuid,
    pub clan_external_id: String,
    pub clan_name: String,
    pub clan_display_name: Option<String>,
    pub clan_role: String,
    pub clan_icon: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MeV2 {
    pub id: Uuid,
    pub username: String,
    pub source: String,
    pub external_id: String,
    pub discord_id: Option<String>,
    pub discord_username: Option<String>,
    pub global_role: String,
    pub bio: Option<String>,
    pub social_links: serde_json::Value,
    pub preferred_lang: Option<String>,
    pub has_custom_avatar: bool,
    pub clans: Vec<ClanMembershipView>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub async fn me_v2(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<MeV2>, (StatusCode, String)> {
    let row: Option<(
        Uuid,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        serde_json::Value,
        Option<String>,
        chrono::DateTime<chrono::Utc>,
    )> = sqlx::query_as(
        r#"SELECT id, username, source, external_id, discord_id, discord_username,
                  global_role, bio, social_links, preferred_lang, created_at
             FROM users WHERE id = $1"#,
    )
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;

    let row = row.ok_or((StatusCode::UNAUTHORIZED, "user gone".into()))?;

    let clans: Vec<ClanMembershipView> = sqlx::query_as(
        r#"SELECT m.clan_id, c.external_id as clan_external_id, c.name as clan_name,
                  c.display_name as clan_display_name, m.clan_role, c.icon as clan_icon
             FROM clan_memberships m JOIN clans c ON c.id = m.clan_id
            WHERE m.user_id = $1 AND m.active = TRUE
            ORDER BY m.joined_at"#,
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    let has_custom_avatar: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM avatars WHERE user_id = $1)")
            .bind(auth.user_id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(false);

    Ok(Json(MeV2 {
        id: row.0,
        username: row.1,
        source: row.2,
        external_id: row.3,
        discord_id: row.4,
        discord_username: row.5,
        global_role: row.6,
        bio: row.7,
        social_links: row.8,
        preferred_lang: row.9,
        has_custom_avatar,
        clans,
        created_at: row.10,
    }))
}
