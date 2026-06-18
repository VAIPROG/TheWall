//! Profile v2: public profile view + edit my own bio/social_links + stats.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
#[allow(unused_imports)]
use serde_json;
use sqlx::FromRow;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};

/// Whitelist for social-link domains. We accept the host name (without scheme
/// or path) and let users put their full URL; the server checks the host
/// matches one of these or starts with one + dot.
const SOCIAL_WHITELIST: &[&str] = &[
    "t.me",
    "telegram.me",
    "telegram.org",
    "twitter.com",
    "x.com",
    "github.com",
    "twitch.tv",
    "youtube.com",
    "youtu.be",
    "steamcommunity.com",
    "discord.com",
    "discord.gg",
    "instagram.com",
    "mastodon.social",
];

#[derive(Debug, Deserialize, Serialize)]
pub struct SocialLink {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfile {
    pub bio: Option<String>,
    pub social_links: Option<Vec<SocialLink>>,
}

fn validate_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("https://") {
        return Err(format!("url must be https://: {url}"));
    }
    let host = lower.trim_start_matches("https://");
    let host = host.split('/').next().unwrap_or("");
    if host.is_empty() {
        return Err(format!("no host in url: {url}"));
    }
    for &allowed in SOCIAL_WHITELIST {
        if host == allowed || host.ends_with(&format!(".{allowed}")) {
            return Ok(());
        }
    }
    Err(format!("domain not allowed: {host}"))
}

pub async fn update_me(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<UpdateProfile>,
) -> Result<StatusCode, (StatusCode, String)> {
    if let Some(ref bio) = body.bio {
        if bio.chars().count() > state.limits.bio_chars {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("bio max {} chars", state.limits.bio_chars),
            ));
        }
    }
    let social_json = match body.social_links {
        Some(links) => {
            if links.len() > state.limits.social_link_count {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("max {} social links", state.limits.social_link_count),
                ));
            }
            for link in &links {
                if link.label.chars().count() > state.limits.social_link_label {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        format!("label max {} chars", state.limits.social_link_label),
                    ));
                }
                validate_url(&link.url).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
            }
            Some(serde_json::to_value(&links).unwrap())
        }
        None => None,
    };

    sqlx::query(
        r#"UPDATE users
              SET bio = COALESCE($1, bio),
                  social_links = COALESCE($2, social_links),
                  updated_at = NOW()
            WHERE id = $3"#,
    )
    .bind(body.bio)
    .bind(social_json)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

// --- public profile view ---------------------------------------------------

#[derive(Debug, Serialize, FromRow)]
pub struct PublicProfile {
    pub id: Uuid,
    pub username: String,
    pub discord_id: Option<String>,
    pub discord_username: Option<String>,
    pub global_role: String,
    pub bio: Option<String>,
    pub social_links: serde_json::Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub has_custom_avatar: bool,
    pub pixels_placed: i64,
    pub templates_approved: i32,
    /// First-active clan membership. Both fields are NULL if the user is
    /// in no clan; this lets the front-end render "<role> · <clan>" cleanly
    /// without a second round-trip.
    pub primary_clan_name: Option<String>,
    pub primary_clan_role: Option<String>,
}

pub async fn get_public(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<PublicProfile>, (StatusCode, String)> {
    let row = sqlx::query_as::<_, PublicProfile>(
        r#"SELECT u.id, u.username, u.discord_id, u.discord_username, u.global_role, u.bio,
                  u.social_links, u.created_at,
                  EXISTS(SELECT 1 FROM avatars a WHERE a.user_id = u.id) AS has_custom_avatar,
                  COALESCE(s.pixels_placed, 0) AS pixels_placed,
                  COALESCE(s.templates_approved, 0) AS templates_approved,
                  cl.primary_clan_name,
                  cl.primary_clan_role
             FROM users u
        LEFT JOIN user_stats s ON s.user_id = u.id
        LEFT JOIN LATERAL (
                  SELECT c.name AS primary_clan_name, m.clan_role AS primary_clan_role
                    FROM clan_memberships m
                    JOIN clans c ON c.id = m.clan_id
                   WHERE m.user_id = u.id AND m.active = true
                   ORDER BY m.joined_at ASC
                   LIMIT 1
              ) cl ON true
            WHERE u.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .ok_or((StatusCode::NOT_FOUND, "user not found".into()))?;
    Ok(Json(row))
}

/// GET /api/v2/users/by-username/{username}
///
/// Same shape as `get_public`, but resolves the user by case-insensitive
/// username instead of UUID. Used by the site-profile-inject content script
/// so it doesn't have to fetch and search the clan roster on every modal open.
pub async fn get_public_by_username(
    State(state): State<AppState>,
    Path(username): Path<String>,
) -> Result<Json<PublicProfile>, (StatusCode, String)> {
    let row = sqlx::query_as::<_, PublicProfile>(
        r#"SELECT u.id, u.username, u.discord_id, u.discord_username, u.global_role, u.bio,
                  u.social_links, u.created_at,
                  EXISTS(SELECT 1 FROM avatars a WHERE a.user_id = u.id) AS has_custom_avatar,
                  COALESCE(s.pixels_placed, 0) AS pixels_placed,
                  COALESCE(s.templates_approved, 0) AS templates_approved,
                  cl.primary_clan_name,
                  cl.primary_clan_role
             FROM users u
        LEFT JOIN user_stats s ON s.user_id = u.id
        LEFT JOIN LATERAL (
                  SELECT c.name AS primary_clan_name, m.clan_role AS primary_clan_role
                    FROM clan_memberships m
                    JOIN clans c ON c.id = m.clan_id
                   WHERE m.user_id = u.id AND m.active = true
                   ORDER BY m.joined_at ASC
                   LIMIT 1
              ) cl ON true
            WHERE LOWER(u.username) = LOWER($1)
            LIMIT 1"#,
    )
    .bind(username.trim())
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .ok_or((StatusCode::NOT_FOUND, "user not found".into()))?;
    Ok(Json(row))
}

// --- client-pushed stats ---------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct StatsPush {
    pub pixels_placed_delta: Option<i64>,
}

pub async fn push_stats(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(p): Json<StatsPush>,
) -> Result<StatusCode, (StatusCode, String)> {
    let delta = p.pixels_placed_delta.unwrap_or(0).clamp(0, 100_000);
    sqlx::query(
        r#"INSERT INTO user_stats (user_id, pixels_placed, last_pushed)
           VALUES ($1, $2, NOW())
           ON CONFLICT (user_id) DO UPDATE
             SET pixels_placed = user_stats.pixels_placed + EXCLUDED.pixels_placed,
                 last_pushed = NOW()"#,
    )
    .bind(auth.user_id)
    .bind(delta)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}
