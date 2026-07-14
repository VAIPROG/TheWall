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
