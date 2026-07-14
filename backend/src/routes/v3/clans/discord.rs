//! Clan-scoped Discord integration: fetch the caller's owned guilds during the
//! clan-guilds OAuth round-trip (token never stored), and (in later tasks)
//! create/verify clans against the server-verified owned-guild cache.
use axum::http::StatusCode;
use serde::Deserialize;
use std::collections::HashSet;
use uuid::Uuid;

use crate::AppState;

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
