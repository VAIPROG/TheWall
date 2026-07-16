//! Centralised application configuration loaded from environment variables.
//!
//! All env-var reads happen here. Anything else in the crate that needs
//! boot-time config should receive it through `AppState` rather than calling
//! `std::env::var` directly.

use std::{collections::HashMap, env, sync::Arc};

use chrono::{DateTime, Utc};
use tokio::sync::RwLock;

/// Full application configuration.
#[derive(Clone, Debug)]
pub struct AppConfig {
    pub database_url: String,
    pub jwt_secret: String,
    pub site_url: String,
    pub port: String,
    pub public_base_url: Option<String>,
    /// Wall front-end origins where the extension runs and consumes ?the_wall_dev= share links (e.g. https://filianislost.com). Configurable via WALL_SITES (comma-separated).
    pub wall_sites: Vec<String>,
    pub extension_version: Option<String>,
    pub oauth: OAuthConfig,
    pub limits: LimitsConfig,
    pub notify: NotifyTargets,
    pub maintenance: MaintenanceConfig,
    pub runtime: Arc<RwLock<RuntimeConfig>>,
    pub owner: ServerOwnerConfig,
    pub owner_seed: Option<OwnerSeed>,
}

impl AppConfig {
    /// Load configuration from the process environment. Panics on the
    /// mandatory variables `DATABASE_URL` and `JWT_SECRET`.
    pub fn load() -> Self {
        Self {
            database_url: env::var("DATABASE_URL").expect("DATABASE_URL must be set"),
            jwt_secret: env::var("JWT_SECRET").expect("JWT_SECRET must be set"),
            site_url: env::var("SITE_URL")
                .unwrap_or_else(|_| "https://filianislost.com".to_string()),
            port: env::var("PORT").unwrap_or_else(|_| "3080".to_string()),
            public_base_url: opt_env("PUBLIC_BASE_URL"),
            wall_sites: env::var("WALL_SITES").ok()
                .map(|s| s.split(',').map(|w| w.trim().trim_end_matches('/').to_string()).filter(|w| !w.is_empty()).collect::<Vec<_>>())
                .filter(|v: &Vec<String>| !v.is_empty())
                .unwrap_or_else(|| vec!["https://filianislost.com".to_string()]),
            extension_version: opt_env("EXTENSION_VERSION"),
            oauth: OAuthConfig::load(),
            limits: LimitsConfig::load(),
            notify: NotifyTargets::load(),
            maintenance: MaintenanceConfig::load(),
            runtime: {
                let maintenance = MaintenanceConfig::load();
                Arc::new(RwLock::new(RuntimeConfig::from_env_defaults(&maintenance)))
            },
            owner: ServerOwnerConfig::load(),
            owner_seed: OwnerSeed::load(),
        }
    }
}


#[derive(Clone, Debug, Default)]
pub struct OAuthConfig {
    /// Telegram bot token from @BotFather. Used as Bearer for Bot API calls.
    pub telegram_bot_token: Option<String>,
    /// Optional human-readable bot username (e.g. "@MyAppBot") for UI hints.
    pub telegram_bot_username: Option<String>,
    /// Telegram OIDC Client ID.
    pub telegram_client_id: Option<String>,
    /// Telegram OIDC Client Secret.
    pub telegram_client_secret: Option<String>,
    pub discord_client_id: Option<String>,
    pub discord_client_secret: Option<String>,
    /// GitHub OAuth app Client ID.
    pub github_client_id: Option<String>,
    /// GitHub OAuth app Client Secret.
    pub github_client_secret: Option<String>,
    /// Discord *bot* token.
    pub discord_bot_token: Option<String>,
    /// Discord application id.
    pub discord_application_id: Option<String>,
    /// Ed25519 public key (hex) from the Discord developer portal.
    pub discord_public_key: Option<String>,
    /// Shared callback page on the static site.
    pub discord_redirect_uri: String,
    pub support_email: String,
}

impl OAuthConfig {
    fn load() -> Self {
        Self {
            telegram_bot_token: opt_env("TELEGRAM_BOT_TOKEN"),
            telegram_bot_username: opt_env("TELEGRAM_BOT_USERNAME"),
            telegram_client_id: opt_env("TELEGRAM_CLIENT_ID"),
            telegram_client_secret: opt_env("TELEGRAM_CLIENT_SECRET"),
            discord_client_id: opt_env("DISCORD_CLIENT_ID"),
            discord_client_secret: opt_env("DISCORD_CLIENT_SECRET"),
            github_client_id: opt_env("GITHUB_CLIENT_ID"),
            github_client_secret: opt_env("GITHUB_CLIENT_SECRET"),
            discord_bot_token: opt_env("DISCORD_BOT_TOKEN"),
            discord_application_id: opt_env("DISCORD_APPLICATION_ID"),
            discord_public_key: opt_env("DISCORD_PUBLIC_KEY"),
            discord_redirect_uri: env::var("DISCORD_REDIRECT_URI")
                .unwrap_or_else(|_| "https://the-wall.vai-rice.space/vai-auth/".to_string()),
            support_email: env::var("SUPPORT_EMAIL")
                .unwrap_or_else(|_| "vadim+the_wall@vai-rice.space".to_string()),
        }
    }
}

/// Length caps for user-supplied strings. Every limit is bounded by a hard
/// ceiling (`HARD_MAX`); env-supplied values above the ceiling are clamped.
#[derive(Clone, Debug)]
pub struct LimitsConfig {
    pub message_chars: usize,
    pub bio_chars: usize,
    pub social_link_label: usize,
    pub social_link_count: usize,
}

impl LimitsConfig {
    pub const HARD_MAX: usize = 4096;
    fn cap(v: usize, default: usize) -> usize {
        v.clamp(1, Self::HARD_MAX).min(default.max(1))
    }
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            message_chars: 4000,
            bio_chars: 500,
            social_link_label: 40,
            social_link_count: 12,
        }
    }
}

impl LimitsConfig {
    fn load() -> Self {
        let parse_usize = |k: &str, d: usize| {
            env::var(k)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d)
        };
        Self {
            message_chars: Self::cap(parse_usize("LIMIT_MESSAGE_CHARS", 4000), 4096),
            bio_chars: Self::cap(parse_usize("LIMIT_BIO_CHARS", 500), 4096),
            social_link_label: Self::cap(parse_usize("LIMIT_SOCIAL_LABEL", 40), 4096),
            social_link_count: parse_usize("LIMIT_SOCIAL_COUNT", 12).clamp(1, 64),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct NotifyTargets {
    pub discord_user_id: Option<String>,
    pub telegram_user_id: Option<String>,
    pub telegram_channel_id: Option<String>,
    pub telegram_channel_username: Option<String>,
    /// Period between automatic snapshots, seconds. Default 240 (4 min).
    pub snapshot_interval_secs: u64,
    /// Send the periodic snapshot album to `telegram_user_id` as a DM.
    pub telegram_snapshot_dm: bool,
    /// Telegram user ids allowed to run admin bot commands.
    pub telegram_admin_ids: Vec<String>,
    /// Discord parity registry.
    pub discord_admin_ids: Vec<String>,
}

impl NotifyTargets {
    fn load() -> Self {
        Self {
            discord_user_id: opt_env("DISCORD_NOTIFY_USER_ID"),
            telegram_user_id: opt_env("TELEGRAM_NOTIFY_USER_ID"),
            telegram_channel_id: opt_env("TELEGRAM_NOTIFY_CHANNEL_ID"),
            telegram_channel_username: opt_env("TELEGRAM_NOTIFY_CHANNEL_USERNAME"),
            snapshot_interval_secs: env::var("SNAPSHOT_INTERVAL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(240),
            telegram_snapshot_dm: env::var("TELEGRAM_SNAPSHOT_DM")
                .map(|v| v == "on" || v == "1" || v == "true")
                .unwrap_or(false),
            telegram_admin_ids: split_ids(&env::var("TELEGRAM_ADMIN_IDS").unwrap_or_default()),
            discord_admin_ids: split_ids(&env::var("DISCORD_ADMIN_IDS").unwrap_or_default()),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct MaintenanceConfig {
    pub enabled: bool,
    pub reason: Option<String>,
    pub estimated_duration_minutes: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct ServerOwnerConfig {
    pub name: String,
    pub contact: String,
    pub link: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct OwnerSeed {
    pub username: String,
    pub external_id: String,
    pub source: String,
    pub role: String,
    pub global_role: String,
}

impl MaintenanceConfig {
    fn load() -> Self {
        let enabled = env::var("WALL_MAINTENANCE_MODE")
            .map(|v| matches!(v.as_str(), "1" | "true" | "on"))
            .unwrap_or(false);
        Self {
            enabled,
            reason: env::var("WALL_MAINTENANCE_REASON").ok().filter(|s| !s.trim().is_empty()),
            estimated_duration_minutes: env::var("WALL_MAINTENANCE_DURATION_MINUTES")
                .ok()
                .and_then(|v| v.parse().ok()),
        }
    }
}

impl ServerOwnerConfig {
    fn load() -> Self {
        Self {
            name: env::var("WALL_OWNER_NAME")
                .unwrap_or_else(|_| "The Wall Dev".to_string()),
            contact: env::var("WALL_OWNER_CONTACT")
                .unwrap_or_else(|_| "vadim+the_wall@vai-rice.space".to_string()),
            link: opt_env("WALL_OWNER_LINK"),
        }
    }
}

impl OwnerSeed {
    fn load() -> Option<Self> {
        let raw = env::var("WALL_OWNER_SEED").ok()?;
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        let v: serde_json::Value = serde_json::from_str(raw).ok()?;
        Some(Self {
            username: v.get("username")?.as_str()?.to_string(),
            external_id: v.get("external_id")?.as_str()?.to_string(),
            source: v.get("source").and_then(|v| v.as_str()).unwrap_or("site").to_string(),
            role: v.get("role").and_then(|v| v.as_str()).unwrap_or("admin").to_string(),
            global_role: v.get("global_role").and_then(|v| v.as_str()).unwrap_or("owner").to_string(),
        })
    }
}

/// Runtime server configuration that can be mutated by admin endpoints.
/// Initialised from defaults; env vars provide the boot defaults but admins
/// can toggle feature flags and maintenance mode without a restart.
#[derive(Clone, Debug, Default)]
pub struct RuntimeConfig {
    pub max_users_per_clan: i32,
    pub max_templates_per_user: i32,
    pub max_api_keys_per_user: i32,
    pub max_file_size_mb: i32,
    pub rate_limit_per_minute: i32,
    pub maintenance_mode: bool,
    pub maintenance_reason: Option<String>,
    pub maintenance_estimated_end: Option<DateTime<Utc>>,
    pub feature_flags: HashMap<String, bool>,
    pub allow_public_template_publishing: bool,
    pub auto_approve_moderator_templates: bool,
}

impl RuntimeConfig {
    /// Initialise from env defaults and boot-time maintenance config.
    pub fn from_env_defaults(maintenance: &MaintenanceConfig) -> Self {
        Self {
            max_users_per_clan: 100,
            max_templates_per_user: 50,
            max_api_keys_per_user: 5,
            max_file_size_mb: 10,
            rate_limit_per_minute: 60,
            maintenance_mode: maintenance.enabled,
            maintenance_reason: maintenance.reason.clone(),
            maintenance_estimated_end: maintenance
                .estimated_duration_minutes
                .map(|m| Utc::now() + chrono::Duration::minutes(m)),
            feature_flags: HashMap::new(),
            allow_public_template_publishing: true,
            auto_approve_moderator_templates: true,
        }
    }
}

/// Read an optional env var, treating empty/whitespace-only values as unset.
pub fn opt_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn split_ids(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Every env var the backend reads anywhere.
const KNOWN_ENV_KEYS: &[&str] = &[
    "DATABASE_URL",
    "JWT_SECRET",
    "PORT",
    "SITE_URL",
    "RUST_LOG",
    "PUBLIC_BASE_URL",
    "WALL_SITES",
    "LIMIT_MESSAGE_CHARS",
    "LIMIT_BIO_CHARS",
    "LIMIT_SOCIAL_LABEL",
    "LIMIT_SOCIAL_COUNT",
    "SNAPSHOT_INTERVAL_SECS",
    "SUPPORT_EMAIL",
    "EXTENSION_VERSION",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_USERNAME",
    "TELEGRAM_CLIENT_ID",
    "TELEGRAM_CLIENT_SECRET",
    "TELEGRAM_NOTIFY_USER_ID",
    "TELEGRAM_NOTIFY_CHANNEL_ID",
    "TELEGRAM_NOTIFY_CHANNEL_USERNAME",
    "TELEGRAM_SNAPSHOT_DM",
    "TELEGRAM_ADMIN_IDS",
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "DISCORD_BOT_TOKEN",
    "DISCORD_BOT",
    "DISCORD_REDIRECT_URI",
    "DISCORD_NOTIFY_USER_ID",
    "DISCORD_ADMIN_IDS",
    "DISCORD_APPLICATION_ID",
    "DISCORD_PUBLIC_KEY",
    "THE_WALL_DEV_ENV_FILE",
    "WALL_MAINTENANCE_MODE",
    "WALL_MAINTENANCE_REASON",
    "WALL_MAINTENANCE_DURATION_MINUTES",
    "WALL_OWNER_SEED",
    "WALL_OWNER_NAME",
    "WALL_OWNER_CONTACT",
    "WALL_OWNER_LINK",
];

/// Flag env-file keys the backend never reads. A misspelled key is otherwise
/// invisible: the right key stays unset and the feature silently turns off.
pub fn warn_unknown_env_keys<I>(iter: Option<I>)
where
    I: Iterator<Item = Result<(String, String), dotenvy::Error>>,
{
    let Some(iter) = iter else { return };
    for (key, _) in iter.flatten() {
        if KNOWN_ENV_KEYS.contains(&key.as_str()) {
            continue;
        }
        match KNOWN_ENV_KEYS
            .iter()
            .map(|k| (k, levenshtein(&key, k)))
            .min_by_key(|(_, d)| *d)
            .filter(|(_, d)| *d <= 3)
        {
            Some((suggestion, _)) => eprintln!(
                "[boot] WARNING: env key {key} is not recognised — did you mean {suggestion}?"
            ),
            None => eprintln!("[boot] WARNING: env key {key} is not recognised (typo?)"),
        }
    }
}

fn levenshtein(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur.push((prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Load an env file (override mode when `THE_WALL_DEV_ENV_FILE` is set,
/// otherwise `.env`), then warn about unknown keys.
pub fn load_env_file() {
    if let Ok(path) = env::var("THE_WALL_DEV_ENV_FILE") {
        match dotenvy::from_path_override(&path) {
            Ok(_) => eprintln!("[boot] loaded env from THE_WALL_DEV_ENV_FILE={path} (override)"),
            Err(e) => eprintln!("[boot] THE_WALL_DEV_ENV_FILE={path} unreadable: {e}"),
        }
        warn_unknown_env_keys(dotenvy::from_path_iter(&path).ok());
        return;
    }
    let loaded = dotenvy::dotenv().is_ok();
    if loaded {
        warn_unknown_env_keys(dotenvy::dotenv_iter().ok());
    }
}
