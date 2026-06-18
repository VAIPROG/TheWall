//! Multi-site abstraction.
//!
//! Every user, clan, template and mailbox item carries a `source` column that
//! identifies which pixel-canvas service they came from. Today we support
//! filianislost.com fully; wplace.live is wired up as a stub so the rest of
//! the codebase already understands "there are multiple sources".
//!
//! Adding a new site = adding a new `SiteConfig` entry + implementing
//! `verify_token` for it. Nothing else in the codebase needs to change.

use serde::{Deserialize, Serialize};

/// Which third-party canvas a user / clan belongs to.
///
/// Stored in DB as a lowercase string; we keep the enum small so the parser
/// stays exhaustive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Filianislost,
    Wplace,
}

#[allow(dead_code)] // as_str/parse: multi-site future (wplace)
impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Filianislost => "filianislost",
            Source::Wplace => "wplace",
        }
    }
    pub fn parse(s: &str) -> Option<Source> {
        match s.to_ascii_lowercase().as_str() {
            "filianislost" | "fillianislost" | "filian" | "wall" => Some(Source::Filianislost),
            "wplace" | "wplace.live" => Some(Source::Wplace),
            _ => None,
        }
    }
}

impl Default for Source {
    fn default() -> Self {
        Source::Filianislost
    }
}

/// Static per-site config: where to hit it, how big its canvas is, etc.
#[allow(dead_code)] // label/api_base unused until the auth refactor lands
pub struct SiteConfig {
    pub source: Source,
    /// Display name in the UI.
    pub label: &'static str,
    /// Base URL of the public API (used to verify the user's site token).
    pub api_base: &'static str,
    /// Tile-server base ({base}/tiles/{layer}/{x}/{y}.png).
    pub tile_base: &'static str,
    /// Canvas size in pixels.
    pub width: u32,
    pub height: u32,
}

pub const FILIANISLOST: SiteConfig = SiteConfig {
    source: Source::Filianislost,
    label: "The Wall (filianislost.com)",
    api_base: "https://filianislost.com",
    tile_base: "https://ws.filianislost.com",
    width: 6000,
    height: 4200,
};

// Stub — wplace.live API endpoints filled in when we wire it up.
pub const WPLACE: SiteConfig = SiteConfig {
    source: Source::Wplace,
    label: "WPlace (wplace.live)",
    api_base: "https://wplace.live",
    tile_base: "https://backend.wplace.live",
    width: 2000,
    height: 2000,
};

pub fn config_for(source: Source) -> &'static SiteConfig {
    match source {
        Source::Filianislost => &FILIANISLOST,
        Source::Wplace => &WPLACE,
    }
}

// NOTE: the verification machinery below is currently UNUSED — routes/auth.rs
// still carries its own inline filianislost flow. It is kept (allow(dead_code))
// as the target shape for the multi-site refactor (wplace), at which point
// auth.rs should switch to sites::verify and drop its duplicate.
#[allow(dead_code)]
/// Result of verifying a site token: enough to upsert a user record.
#[derive(Debug, Clone)]
pub struct VerifiedSiteUser {
    pub source: Source,
    pub external_id: String,
    pub username: String,
    pub discord_id: Option<String>,
    pub discord_username: Option<String>,
    /// External clan info, if the user is in one. We mirror this into our
    /// clans + clan_memberships tables.
    pub clan: Option<VerifiedSiteClan>,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct VerifiedSiteClan {
    pub external_id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub discord_id: Option<String>,
    pub icon: Option<String>,
    /// Clan role as the source site reports it. We map to our normalised set.
    pub role: Option<String>,
}

/// Verify a token against the appropriate source. Each branch knows the
/// upstream API; the caller doesn't have to.
#[allow(dead_code)]
pub async fn verify(source: Source, site_token: &str) -> Result<VerifiedSiteUser, String> {
    match source {
        Source::Filianislost => verify_filianislost(site_token).await,
        Source::Wplace => Err("wplace verification not yet implemented".into()),
    }
}

// ---- filianislost --------------------------------------------------------

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct FilianClan {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    discord_id: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    role: Option<String>,
    // The site uses different keys across builds for the clan id; we accept
    // either.
    #[serde(default)]
    id: Option<serde_json::Value>,
    #[serde(default)]
    clan_id: Option<serde_json::Value>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct FilianUser {
    id: i64,
    username: String,
    #[serde(default)]
    discord_id: Option<String>,
    #[serde(default)]
    discord_username: Option<String>,
    #[serde(default)]
    clan: Option<FilianClan>,
}

#[allow(dead_code)]
async fn verify_filianislost(site_token: &str) -> Result<VerifiedSiteUser, String> {
    let client = reqwest::Client::new();
    let r = client
        .get(format!("{}/user/me", FILIANISLOST.api_base))
        .header("Authorization", site_token)
        .send()
        .await
        .map_err(|e| format!("upstream: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("upstream status {}", r.status()));
    }
    let u: FilianUser = r.json().await.map_err(|e| format!("decode: {e}"))?;

    let clan = u.clan.and_then(|c| {
        let ext_id = c.clan_id.as_ref().or(c.id.as_ref()).and_then(|v| match v {
            serde_json::Value::Number(n) => Some(n.to_string()),
            serde_json::Value::String(s) => Some(s.clone()),
            _ => None,
        });
        ext_id.and_then(|ext| {
            c.name.clone().map(|name| VerifiedSiteClan {
                external_id: ext,
                name,
                display_name: c.display_name,
                discord_id: c.discord_id,
                icon: c.icon,
                role: c.role,
            })
        })
    });

    Ok(VerifiedSiteUser {
        source: Source::Filianislost,
        external_id: u.id.to_string(),
        username: u.username,
        discord_id: u.discord_id,
        discord_username: u.discord_username,
        clan,
    })
}
