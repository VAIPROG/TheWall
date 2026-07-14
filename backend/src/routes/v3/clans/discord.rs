//! Clan-scoped Discord integration: fetch the caller's owned guilds during the
//! clan-guilds OAuth round-trip (token never stored), and (in later tasks)
//! create/verify clans against the server-verified owned-guild cache.
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser, http_error::ResultExt};

#[derive(Debug, Deserialize)]
struct DiscordGuild {
    id: String,
    #[serde(default)]
    owner: bool,
}

/// Called from the OAuth callback for `purpose = "clan-guilds"`: GET the user's
/// guilds with the just-issued token, keep `owner == true`, cache the ids, and
/// discard the token.
pub async fn ingest_owned_guilds(
    state: &AppState,
    user_id: Uuid,
    access_token: &str,
) -> Result<(), (StatusCode, String)> {
    let client = reqwest::Client::new();
    let guilds: Vec<DiscordGuild> = client
        .get("https://discord.com/api/v10/users/@me/guilds")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("discord guilds fetch: {e}")))?
        .json()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("discord guilds decode: {e}")))?;

    let owned: HashSet<String> = guilds.into_iter().filter(|g| g.owner).map(|g| g.id).collect();
    state.guild_cache.put(user_id, owned).await;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuildOut {
    pub id: String,
}

/// The caller's currently-verified owned guild ids (from the cache). The client
/// re-runs the clan-guilds OAuth flow if this is empty.
pub async fn owned_guilds(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<GuildOut>>, (StatusCode, String)> {
    let ids = state.guild_cache.list(auth.user_id).await;
    Ok(Json(ids.into_iter().map(|id| GuildOut { id }).collect()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionOut {
    pub source: String,
    pub external_id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub discord_id: Option<String>,
    pub icon: Option<String>,
}

/// The user's stored filianislost site-clan suggestion, or 204 when none.
pub async fn site_suggestion(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let row: Option<SuggestionOut> = sqlx::query_as::<_, (String, String, String, Option<String>, Option<String>, Option<String>)>(
        "SELECT source, external_id, name, display_name, discord_id, icon FROM clan_suggestions WHERE user_id = $1",
    )
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?
    .map(|(source, external_id, name, display_name, discord_id, icon)| SuggestionOut {
        source, external_id, name, display_name, discord_id, icon,
    });

    match row {
        Some(s) => Ok(Json(s).into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FromGuildReq {
    pub guild_id: String,
    pub name: Option<String>,
    pub tag: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanCreated {
    pub id: Uuid,
}

/// Make the creator an admin member of a freshly-created clan. Mirrors the role
/// string + columns `create.rs` uses for the founder (`clan_role = 'admin'`).
async fn insert_admin_membership(
    state: &AppState,
    user_id: Uuid,
    clan_id: Uuid,
) -> Result<(), (StatusCode, String)> {
    sqlx::query(
        r#"INSERT INTO clan_memberships (id, user_id, clan_id, clan_role, active, joined_at)
           VALUES (gen_random_uuid(), $1, $2, 'admin', TRUE, NOW())
           ON CONFLICT (user_id, clan_id) DO UPDATE
               SET clan_role = 'admin', active = TRUE"#,
    )
    .bind(user_id)
    .bind(clan_id)
    .execute(&state.pool)
    .await
    .or_500()?;
    Ok(())
}

/// Create a clan bound to a Discord guild the caller was server-verified to own.
pub async fn create_from_guild(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<FromGuildReq>,
) -> Result<Json<ClanCreated>, (StatusCode, String)> {
    if !state.guild_cache.take(auth.user_id, &body.guild_id).await {
        return Err((
            StatusCode::FORBIDDEN,
            "guild ownership not verified (re-run the Discord consent)".to_string(),
        ));
    }
    let exists: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM clans WHERE source = 'discord' AND external_id = $1",
    )
    .bind(&body.guild_id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;
    if exists.is_some() {
        return Err((StatusCode::CONFLICT, "this guild is already a clan".to_string()));
    }
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("New Clan");
    let clan_id: Uuid = sqlx::query_scalar(
        r#"INSERT INTO clans
               (id, source, external_id, discord_id, name, tag, owner_id,
                owner_verified, owner_verified_via, owner_verified_at)
           VALUES (gen_random_uuid(), 'discord', $1, $1, $2, $3, $4, TRUE, 'discord', NOW())
           RETURNING id"#,
    )
    .bind(&body.guild_id)
    .bind(name)
    .bind(body.tag.as_deref())
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await
    .or_500()?;
    insert_admin_membership(&state, auth.user_id, clan_id).await?;
    Ok(Json(ClanCreated { id: clan_id }))
}

/// Create an OWNER-UNVERIFIED clan from the caller's stored site suggestion.
pub async fn create_from_site(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<ClanCreated>, (StatusCode, String)> {
    let sug: Option<(String, String, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT external_id, name, display_name, discord_id, icon FROM clan_suggestions WHERE user_id = $1",
        )
        .bind(auth.user_id)
        .fetch_optional(&state.pool)
        .await
        .or_500()?;
    let Some((external_id, name, display_name, discord_id, icon)) = sug else {
        return Err((StatusCode::CONFLICT, "no site clan to import".to_string()));
    };
    let exists: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM clans WHERE source = 'filianislost' AND external_id = $1",
    )
    .bind(&external_id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;
    if exists.is_some() {
        return Err((StatusCode::CONFLICT, "this clan already exists".to_string()));
    }
    let clan_id: Uuid = sqlx::query_scalar(
        r#"INSERT INTO clans
               (id, source, external_id, discord_id, name, display_name, icon,
                owner_id, owner_verified)
           VALUES (gen_random_uuid(), 'filianislost', $1, $2, $3, $4, $5, $6, FALSE)
           RETURNING id"#,
    )
    .bind(&external_id)
    .bind(discord_id.as_deref())
    .bind(&name)
    .bind(display_name.as_deref())
    .bind(icon.as_deref())
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await
    .or_500()?;
    insert_admin_membership(&state, auth.user_id, clan_id).await?;
    Ok(Json(ClanCreated { id: clan_id }))
}
