mod auth;
mod bot_commands;
mod bot_core;
mod discord_commands;
mod discord_gateway;
mod formats;
mod models;
mod region_guard;
mod reminder_worker;
mod routes;
mod signals;
mod sites;
mod snapshot_worker;
mod telegram_rich;
mod wall_tiles;

use axum::{
    Router,
    routing::{delete, get, post, put},
};
use sqlx::postgres::PgPoolOptions;
use std::env;
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::PgPool,
    pub jwt_secret: String,
    pub site_url: String,
    pub oauth: OAuthConfig,
    pub limits: LimitsConfig,
    pub notify: NotifyTargets,
}

#[derive(Clone, Default)]
pub struct OAuthConfig {
    /// Telegram bot token from @BotFather. Used as Bearer for Bot API calls
    /// (sendDocument, etc.). NOT used as the OIDC client_secret anymore.
    pub telegram_bot_token: Option<String>,
    /// Optional human-readable bot username (e.g. "@MyAppBot") for UI hints.
    pub telegram_bot_username: Option<String>,
    /// Telegram OIDC Client ID — bot's numeric ID from @BotFather → Web Login.
    pub telegram_client_id: Option<String>,
    /// Telegram OIDC Client Secret — distinct value from @BotFather → Web Login.
    pub telegram_client_secret: Option<String>,
    pub discord_client_id: Option<String>,
    pub discord_client_secret: Option<String>,
    /// Discord *bot* token (separate from OAuth secret) used for Bot API
    /// calls like opening a DM channel + posting attachments.
    pub discord_bot_token: Option<String>,
    /// Discord application id — needed to register global slash commands.
    pub discord_application_id: Option<String>,
    /// Ed25519 public key (hex) from the Discord developer portal; verifies
    /// interaction webhook signatures. Without it the endpoint is disabled.
    pub discord_public_key: Option<String>,
    /// Shared callback page on the static site for both providers' redirects.
    pub discord_redirect_uri: String,
    pub support_email: String,
}

/// Length caps for user-supplied strings. Every limit is bounded by a hard
/// ceiling (`HARD_MAX`); env-supplied values above the ceiling are clamped.
#[derive(Clone)]
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

#[derive(Clone, Default)]
pub struct NotifyTargets {
    /// Where to drop the periodic wall snapshot files.
    pub discord_user_id: Option<String>,
    pub telegram_user_id: Option<String>,
    pub telegram_channel_id: Option<String>,
    pub telegram_channel_username: Option<String>, // for building https://t.me/<name>/<msg_id>
    /// Period between automatic snapshots, seconds. Default 240 (4 min).
    /// Snapshots are aligned to the wall clock so they always land on a
    /// minute that's a multiple of `snapshot_interval_secs / 60`.
    pub snapshot_interval_secs: u64,
    /// Send the periodic snapshot album to `telegram_user_id` as a DM.
    /// Default OFF — the channel is the broadcast target; admins pull the
    /// latest on demand with the bot's /snapshot command.
    pub telegram_snapshot_dm: bool,
    /// Telegram user ids allowed to run admin bot commands (also seeded into
    /// the bot_admins table at boot).
    pub telegram_admin_ids: Vec<String>,
    /// Discord parity registry — stored now, transport lands later.
    pub discord_admin_ids: Vec<String>,
}

/// Boot-time env loader.
///
/// Priority:
///   1. If `THE_WALL_DEV_ENV_FILE` is set, every variable in that file is
///      loaded *and overrides* anything that was already in the process
///      environment. This is the "config file is the source of truth" mode —
///      handy when you keep secrets in `/etc/the-wall/secrets.env` and want a
///      sysadmin edit to take effect on next restart without touching the
///      systemd unit.
///   2. Otherwise we fall back to the default behaviour: read `.env` from the
///      current working directory, *without* overriding anything systemd or
///      the shell already provided.
///
/// In both cases we never panic on a missing file: env vars from the actual
/// environment still work, so a misconfigured `THE_WALL_DEV_ENV_FILE` only
/// produces a warning in the log.
fn load_env_config() {
    if let Ok(path) = std::env::var("THE_WALL_DEV_ENV_FILE") {
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

/// Every env var the backend reads anywhere. Keep in sync when adding a new
/// `env::var(...)` — the boot check below flags any file key that's not in
/// this list, which is how a typo'd key gets caught instead of silently
/// evaluating to "feature off".
const KNOWN_ENV_KEYS: &[&str] = &[
    "DATABASE_URL",
    "JWT_SECRET",
    "PORT",
    "SITE_URL",
    "RUST_LOG",
    "PUBLIC_BASE_URL",
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
    "DISCORD_BOT_TOKEN",
    "DISCORD_BOT", // legacy fallback read by routes/avatar.rs
    "DISCORD_REDIRECT_URI",
    "DISCORD_NOTIFY_USER_ID",
    "DISCORD_ADMIN_IDS",
    "DISCORD_APPLICATION_ID",
    "DISCORD_PUBLIC_KEY",
    "THE_WALL_DEV_ENV_FILE",
];

/// Flag env-file keys the backend never reads. Runs before tracing is up, so
/// it speaks `eprintln!` like the rest of the boot path. A misspelled key is
/// otherwise invisible: the right key stays unset and the feature silently
/// turns off — exactly the failure mode this exists to surface.
fn warn_unknown_env_keys<I>(iter: Option<I>)
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

/// Plain O(m·n) edit distance — only runs once per unknown env key at boot.
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

/// Read an optional env var, treating empty/whitespace-only values as unset.
/// `KEY=` left in the file would otherwise arrive as `Some("")` and sail
/// through `if let Some(...)` guards into confusing mid-request failures.
fn opt_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// One boot-time pass over the optional feature knobs: every unset value
/// logs a warning naming the feature it turns off. Loud beats silent — a
/// missing var here is the difference between "bot offline, no idea why" and
/// a one-line answer in the journal.
fn warn_unset_config(oauth: &OAuthConfig, notify: &NotifyTargets) {
    let checks: &[(&str, bool, &str)] = &[
        ("TELEGRAM_BOT_TOKEN", oauth.telegram_bot_token.is_some(),
         "Telegram bot disabled (snapshots, DMs, admin commands)"),
        ("TELEGRAM_CLIENT_ID", oauth.telegram_client_id.is_some(),
         "Telegram OAuth linking/sign-in disabled"),
        ("TELEGRAM_CLIENT_SECRET", oauth.telegram_client_secret.is_some(),
         "Telegram OAuth linking/sign-in disabled"),
        ("DISCORD_CLIENT_ID", oauth.discord_client_id.is_some(),
         "Discord OAuth linking/sign-in disabled"),
        ("DISCORD_CLIENT_SECRET", oauth.discord_client_secret.is_some(),
         "Discord OAuth linking/sign-in disabled"),
        ("DISCORD_BOT_TOKEN", oauth.discord_bot_token.is_some(),
         "Discord bot disabled (gateway presence, DMs, slash registration)"),
        ("DISCORD_APPLICATION_ID", oauth.discord_application_id.is_some(),
         "Discord slash-command registration disabled"),
        ("DISCORD_PUBLIC_KEY", oauth.discord_public_key.is_some(),
         "Discord interactions webhook disabled — the portal's endpoint URL check will fail with 503"),
        ("TELEGRAM_NOTIFY_USER_ID", notify.telegram_user_id.is_some(),
         "Telegram snapshot/alert DMs disabled"),
        ("TELEGRAM_NOTIFY_CHANNEL_ID", notify.telegram_channel_id.is_some(),
         "Telegram channel snapshots disabled"),
        ("DISCORD_NOTIFY_USER_ID", notify.discord_user_id.is_some(),
         "Discord snapshot/alert DMs disabled"),
        ("TELEGRAM_ADMIN_IDS", !notify.telegram_admin_ids.is_empty(),
         "no Telegram bot admins seeded"),
        ("DISCORD_ADMIN_IDS", !notify.discord_admin_ids.is_empty(),
         "no Discord bot admins seeded"),
    ];
    let mut missing = 0;
    for (key, set, consequence) in checks {
        if !set {
            missing += 1;
            tracing::warn!("config: {key} is empty or unset — {consequence}");
        }
    }
    if missing == 0 {
        tracing::info!("config: all optional feature vars are set");
    }
}

#[tokio::main]
async fn main() {
    load_env_config();
    routes::meta::boot();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let jwt_secret = env::var("JWT_SECRET").expect("JWT_SECRET must be set");
    let site_url = env::var("SITE_URL").unwrap_or_else(|_| "https://filianislost.com".to_string());

    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&database_url)
        .await
        .expect("Failed to connect to database");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run database migrations");

    let oauth = OAuthConfig {
        telegram_bot_token: opt_env("TELEGRAM_BOT_TOKEN"),
        telegram_bot_username: opt_env("TELEGRAM_BOT_USERNAME"),
        telegram_client_id: opt_env("TELEGRAM_CLIENT_ID"),
        telegram_client_secret: opt_env("TELEGRAM_CLIENT_SECRET"),
        discord_client_id: opt_env("DISCORD_CLIENT_ID"),
        discord_client_secret: opt_env("DISCORD_CLIENT_SECRET"),
        discord_bot_token: opt_env("DISCORD_BOT_TOKEN"),
        discord_application_id: opt_env("DISCORD_APPLICATION_ID"),
        discord_public_key: opt_env("DISCORD_PUBLIC_KEY"),
        discord_redirect_uri: env::var("DISCORD_REDIRECT_URI")
            .unwrap_or_else(|_| "https://the-wall.vai-rice.space/vai-auth/".to_string()),
        support_email: env::var("SUPPORT_EMAIL")
            .unwrap_or_else(|_| "vadim+the_wall@vai-rice.space".to_string()),
    };

    let parse_usize =
        |k: &str, d: usize| env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let limits = LimitsConfig {
        message_chars: LimitsConfig::cap(parse_usize("LIMIT_MESSAGE_CHARS", 4000), 4096),
        bio_chars: LimitsConfig::cap(parse_usize("LIMIT_BIO_CHARS", 500), 4096),
        social_link_label: LimitsConfig::cap(parse_usize("LIMIT_SOCIAL_LABEL", 40), 4096),
        social_link_count: parse_usize("LIMIT_SOCIAL_COUNT", 12).clamp(1, 64),
    };
    let notify = NotifyTargets {
        discord_user_id: opt_env("DISCORD_NOTIFY_USER_ID"),
        telegram_user_id: opt_env("TELEGRAM_NOTIFY_USER_ID"),
        telegram_channel_id: opt_env("TELEGRAM_NOTIFY_CHANNEL_ID"),
        telegram_channel_username: opt_env("TELEGRAM_NOTIFY_CHANNEL_USERNAME"),
        // Default 240s = 4 minutes. Each tick is wall-clock aligned (HH:00,
        // HH:04, HH:08, …) — see `snapshot_worker::next_aligned_delay`.
        snapshot_interval_secs: env::var("SNAPSHOT_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(240),
        telegram_snapshot_dm: env::var("TELEGRAM_SNAPSHOT_DM")
            .map(|v| v == "on" || v == "1" || v == "true")
            .unwrap_or(false),
        telegram_admin_ids: env::var("TELEGRAM_ADMIN_IDS")
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        discord_admin_ids: env::var("DISCORD_ADMIN_IDS")
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
    };

    // Loud config audit: name every optional feature that's off and why.
    warn_unset_config(&oauth, &notify);

    // Periodic full-wall snapshot worker — see `snapshot_worker.rs`. Also
    // pulls the signal feed each tick.
    snapshot_worker::spawn(pool.clone(), oauth.clone(), notify.clone());
    // Protected-region guard: server-side state verification + alerts.
    region_guard::spawn(pool.clone(), oauth.clone(), notify.clone());
    // Telegram admin command bot (/help /status /snapshot /logs /regions).
    bot_commands::spawn(pool.clone(), oauth.clone(), notify.clone());
    // Paint refill reminders: 10s sweep, DM delivery via linked channels.
    reminder_worker::spawn(pool.clone(), oauth.clone());
    // Discord slash-command registration (commands answered via the
    // /api/v2/discord/interactions webhook below).
    discord_commands::register_commands(oauth.clone());

    let state = AppState {
        pool,
        jwt_secret,
        site_url,
        oauth,
        limits,
        notify,
    };

    // Discord gateway: keeps the bot's presence Online and serves slash
    // commands as a fallback when the portal has no Interactions Endpoint URL.
    discord_gateway::spawn(state.clone());

    // CORS is handled by nginx — don't add a CorsLayer here or headers will duplicate.

    let app = Router::new()
        // * ════════════════════════ V1 (frozen API) ════════════════════════
        // * No behavioural changes here — the extension's legacy paths and any
        // * third-party consumers depend on these exact shapes. New features
        // * go to /api/v2/*.
        // --- auth: site-token login, JWT refresh, session introspection ---
        .route("/api/auth/site", post(routes::auth::site))
        .route("/api/auth/refresh", post(routes::auth::refresh))
        .route("/api/auth/me", get(routes::auth::me))
        // --- account self-service: delete account, preferred language -----
        .route("/api/me/delete", post(routes::account::delete_account))
        .route("/api/me/lang", put(routes::account::update_lang))
        // --- notifications: pull list, acknowledge by ids ------------------
        .route("/api/notifications", get(routes::notifications::list))
        .route("/api/notifications/ack", post(routes::notifications::ack))
        // --- announcements: global broadcast feed --------------------------
        .route("/api/announcements", get(routes::announcements::list))
        // --- direct messages (legacy DM, superseded by v2 mailbox) ---------
        .route("/api/dm", get(routes::dm::list_dms))
        .route("/api/dm", post(routes::dm::send_dm))
        .route("/api/dm/read", post(routes::dm::mark_dm_read))
        .route("/api/dm/{id}", delete(routes::dm::delete_dm))
        // --- clan: chat, roster, mod applications, template list -----------
        .route("/api/clan/chat", get(routes::clan::chat::list))
        .route("/api/clan/chat", post(routes::clan::chat::create))
        .route("/api/clan/chat/{id}", delete(routes::clan::chat::remove))
        .route("/api/clan/members", get(routes::clan::members::list))
        .route(
            "/api/clan/moderation/apply",
            post(routes::clan::moderation::apply),
        )
        .route("/api/clan/templates", get(routes::clan::templates::list))
        // --- templates (legacy share flow) ----------------------------------
        .route("/api/templates", post(routes::templates::create))
        .route("/api/templates/public", get(routes::templates::list_public))
        .route(
            "/api/templates/{id}/report",
            post(routes::templates::report),
        )
        .route(
            "/api/templates/{id}/approve",
            post(routes::templates::approve),
        )
        .route(
            "/api/templates/{id}",
            delete(routes::templates::delete_template),
        )
        // --- avatars: own CRUD, public fetch, Discord proxy + cache reset ---
        .route("/api/me/avatar", get(routes::avatar::get_my_avatar))
        .route("/api/me/avatar", put(routes::avatar::update_my_avatar))
        .route("/api/me/avatar", delete(routes::avatar::delete_my_avatar))
        .route("/api/avatar", get(routes::avatar::get_avatar))
        .route(
            "/api/discord/avatar",
            get(routes::avatar::get_discord_avatar),
        )
        .route(
            "/api/discord/avatar/cache",
            delete(routes::avatar::clear_discord_cache),
        )
        // --- misc: leaderboard, chat relay, i18n bundles, server meta -------
        .route("/api/stats/leaderboard", get(routes::stats::leaderboard))
        .route("/api/chat/relay", post(routes::chat::relay))
        .route("/api/i18n/{lang}", get(routes::i18n::get_lang))
        .route("/api/meta", get(routes::meta::get_meta))
        // --- admin (global admin/owner only) ---------------------------------
        .route("/api/admin/users", get(routes::admin::list_users))
        .route("/api/admin/users/{id}/role", put(routes::admin::set_role))
        .route("/api/admin/users/{id}", delete(routes::admin::delete_user))
        .route(
            "/api/admin/broadcast",
            post(routes::admin::broadcast_notification),
        )
        .route(
            "/api/admin/moderation",
            get(routes::admin::mod_applications),
        )
        .route(
            "/api/admin/moderation/{id}",
            put(routes::admin::decide_mod_application),
        )
        .route(
            "/api/admin/notifications",
            get(routes::admin::list_notifications),
        )
        .route(
            "/api/admin/notifications/{id}",
            delete(routes::admin::delete_notification),
        )
        .route(
            "/api/admin/templates",
            get(routes::admin::list_all_templates),
        )
        .route(
            "/api/admin/templates/{id}",
            delete(routes::admin::delete_template_admin),
        )
        /* ════════════════════════════ V2 API ══════════════════════════════
         * Rich data shapes + the two-axis (global × clan) role model. */
        // --- auth: rich /me with clans + roles -------------------------------
        .route("/api/v2/auth/me", get(routes::v2::auth::me_v2))
        // --- profiles: public view (by id / username), self-edit, stats push -
        .route("/api/v2/users/{id}", get(routes::v2::profile::get_public))
        .route(
            "/api/v2/users/by-username/{username}",
            get(routes::v2::profile::get_public_by_username),
        )
        .route("/api/v2/me/profile", put(routes::v2::profile::update_me))
        .route(
            "/api/v2/me/stats/push",
            post(routes::v2::profile::push_stats),
        )
        // --- achievements: own list/recheck, public list, special grants -----
        .route(
            "/api/v2/me/achievements",
            get(routes::v2::achievements::list_for_me),
        )
        .route(
            "/api/v2/me/achievements/recheck",
            post(routes::v2::achievements::recheck_me),
        )
        .route(
            "/api/v2/users/{id}/achievements",
            get(routes::v2::achievements::list_for_user),
        )
        .route(
            "/api/v2/me/achievements/found-the-dev",
            post(routes::v2::achievements::grant_found_the_dev),
        )
        .route(
            "/api/v2/me/achievements/event",
            post(routes::v2::achievements::grant_event),
        )
        // --- mailbox: unified inbox (DMs, alerts, modmail, announcements) ----
        .route("/api/v2/mailbox", get(routes::v2::mailbox::list))
        .route("/api/v2/mailbox/dm", post(routes::v2::mailbox::send_dm))
        .route(
            "/api/v2/mailbox/{id}/read",
            post(routes::v2::mailbox::mark_read),
        )
        .route(
            "/api/v2/mailbox/read-all",
            post(routes::v2::mailbox::mark_all_read),
        )
        .route(
            "/api/v2/mailbox/{id}/reply",
            post(routes::v2::mailbox::reply),
        )
        // --- clans: memberships, roster, broadcasts, modmail, role admin -----
        .route("/api/v2/clans/mine", get(routes::v2::clans::list_mine))
        .route(
            "/api/v2/clans/{id}/members",
            get(routes::v2::clans::members),
        )
        .route(
            "/api/v2/clans/{id}/announcements",
            post(routes::v2::clans::post_announcement),
        )
        .route(
            "/api/v2/clans/{id}/alerts",
            post(routes::v2::clans::post_alert),
        )
        .route("/api/v2/clans/{id}/mod-dm", post(routes::v2::clans::mod_dm))
        .route(
            "/api/v2/clans/{id}/modmail",
            post(routes::v2::clans::open_modmail),
        )
        .route(
            "/api/v2/clans/{id}/modmail",
            get(routes::v2::clans::list_modmail),
        )
        .route(
            "/api/v2/clans/{cid}/members/{uid}/role",
            put(routes::v2::clans::set_member_role),
        )
        // --- classic templates: share board with review workflow + pinning ---
        .route("/api/v2/templates", get(routes::v2::templates::list))
        .route("/api/v2/templates", post(routes::v2::templates::create))
        // Share-code access (id + optional password) — auth optional, mirrors
        // the animated /shared endpoint.
        .route(
            "/api/v2/templates/{id}/shared",
            get(routes::v2::templates::shared),
        )
        .route(
            "/api/v2/templates/{id}/approve",
            post(routes::v2::templates::approve),
        )
        .route(
            "/api/v2/templates/{id}/reject",
            post(routes::v2::templates::reject),
        )
        .route(
            "/api/v2/templates/{id}/pin",
            post(routes::v2::templates::pin),
        )
        .route(
            "/api/v2/templates/{id}/pin",
            delete(routes::v2::templates::unpin),
        )
        // --- classic templates: derived assets (preview/PNG/JSON/Charity) ----
        .route(
            "/api/v2/templates/{id}/preview",
            get(routes::v2::template_preview::get_preview),
        )
        .route(
            "/api/v2/templates/{id}/png",
            get(routes::v2::template_preview::get_png),
        )
        .route(
            "/api/v2/templates/{id}/json",
            get(routes::v2::template_preview::get_json),
        )
        .route(
            "/api/v2/templates/{id}/charity",
            get(routes::v2::template_preview::get_charity),
        )
        // --- animated templates: same lifecycle as classic (review + pin +
        //     preview) plus password-shared private links ----------------------
        .route(
            "/api/v2/animated/templates",
            get(routes::v2::anim::list).post(routes::v2::anim::create),
        )
        .route(
            "/api/v2/animated/templates/{id}",
            put(routes::v2::anim::update).delete(routes::v2::anim::remove),
        )
        .route(
            "/api/v2/animated/templates/{id}/approve",
            post(routes::v2::anim::approve),
        )
        .route(
            "/api/v2/animated/templates/{id}/reject",
            post(routes::v2::anim::reject),
        )
        .route(
            "/api/v2/animated/templates/{id}/pin",
            post(routes::v2::anim::pin),
        )
        .route(
            "/api/v2/animated/templates/{id}/pin",
            delete(routes::v2::anim::unpin),
        )
        .route(
            "/api/v2/animated/templates/{id}/preview",
            get(routes::v2::template_preview::get_anim_preview),
        )
        .route(
            "/api/v2/animated/templates/{id}/shared",
            get(routes::v2::anim::shared),
        )
        // --- protected regions: fixed-state guard (supersedes the retired
        //     per-template anti-grief endpoints) -------------------------------
        .route(
            "/api/v2/regions",
            get(routes::v2::regions::list).post(routes::v2::regions::create),
        )
        .route(
            "/api/v2/regions/{id}",
            get(routes::v2::regions::get_one)
                .put(routes::v2::regions::update)
                .delete(routes::v2::regions::remove),
        )
        .route(
            "/api/v2/regions/{id}/report",
            post(routes::v2::regions::report),
        )
        .route(
            "/api/v2/regions/{id}/approve",
            post(routes::v2::regions::approve),
        )
        .route(
            "/api/v2/regions/{id}/reject",
            post(routes::v2::regions::reject),
        )
        // --- paint refill reminders (extension files, worker delivers) -------
        .route(
            "/api/v2/me/paint-reminder",
            post(routes::v2::reminders::create).delete(routes::v2::reminders::cancel),
        )
        // --- notification preferences (per-channel opt-ins) -------------------
        .route(
            "/api/v2/me/notifications",
            get(routes::v2::notifications::get_me),
        )
        .route(
            "/api/v2/me/notifications",
            put(routes::v2::notifications::update_me),
        )
        // --- OAuth sign-in (public): authenticate by linked provider --------
        .route(
            "/api/v2/auth/telegram/login-url",
            get(routes::v2::links::telegram_login_url),
        )
        .route(
            "/api/v2/auth/telegram/exchange",
            post(routes::v2::links::telegram_login_exchange),
        )
        .route(
            "/api/v2/auth/discord/login-url",
            get(routes::v2::links::discord_login_url),
        )
        .route(
            "/api/v2/auth/discord/exchange",
            post(routes::v2::links::discord_login_exchange),
        )
        // --- account links: Telegram (PKCE OIDC), Discord (OAuth2), email ----
        .route("/api/v2/me/links", get(routes::v2::links::get_status))
        .route(
            "/api/v2/me/links/telegram/oauth-url",
            get(routes::v2::links::telegram_oauth_url),
        )
        .route(
            "/api/v2/me/links/telegram/exchange",
            post(routes::v2::links::telegram_exchange),
        )
        .route(
            "/api/v2/me/links/telegram",
            delete(routes::v2::links::unlink_telegram),
        )
        .route(
            "/api/v2/me/links/discord/oauth-url",
            get(routes::v2::links::discord_oauth_url),
        )
        .route(
            "/api/v2/me/links/discord/exchange",
            post(routes::v2::links::discord_exchange),
        )
        .route(
            "/api/v2/me/links/discord",
            delete(routes::v2::links::unlink_discord),
        )
        .route(
            "/api/v2/me/links/email/request",
            post(routes::v2::links::request_email_link),
        )
        // --- VAI account: standalone signup/login + wall-account linking ------
        .route("/api/v2/vai/signup", post(routes::v2::vai_auth::signup))
        .route("/api/v2/vai/login", post(routes::v2::vai_auth::login))
        .route(
            "/api/v2/me/link-vai",
            post(routes::v2::vai_auth::link_to_wall),
        )
        // --- public feed: snapshots + mirrored signals (no auth) --------------
        .route("/api/v2/signals", get(routes::v2::signals_view::list))
        .route(
            "/api/v2/signals/{id}",
            get(routes::v2::signals_view::get_one),
        )
        .route(
            "/api/v2/signals/{id}/notes",
            post(routes::v2::signals_view::upsert_note),
        )
        .route("/api/v2/snapshots", get(routes::v2::feed::list_snapshots))
        // --- Discord interactions webhook: admin slash commands (signature-
        //     verified, public route — auth is the Ed25519 signature itself) --
        .route(
            "/api/v2/discord/interactions",
            post(discord_commands::interactions),
        )
        // --- avatars v2 ---------------------------------------------------------
        .route(
            "/api/v2/avatar/{user_id}",
            get(routes::avatar::get_avatar_v2),
        )
        // --- admin v2: email-link review, runtime config, preview backfill ----
        .route(
            "/api/v2/admin/email-link-requests",
            get(routes::v2::admin_links::list_email_requests),
        )
        .route(
            "/api/v2/admin/email-link-requests/{id}/approve",
            post(routes::v2::admin_links::approve_email_request),
        )
        .route(
            "/api/v2/admin/email-link-requests/{id}/reject",
            post(routes::v2::admin_links::reject_email_request),
        )
        .route(
            "/api/v2/admin/achievements",
            get(routes::v2::achievements::admin_list_catalogue),
        )
        .route(
            "/api/v2/admin/achievements",
            post(routes::v2::achievements::admin_create),
        )
        .route(
            "/api/v2/admin/users/{user_id}/achievements/{achievement_id}",
            post(routes::v2::achievements::admin_grant),
        )
        .route(
            "/api/v2/admin/users/{user_id}/achievements/{achievement_id}",
            delete(routes::v2::achievements::admin_revoke),
        )
        .route(
            "/api/v2/admin/achievements/{achievement_id}/by-username",
            post(routes::v2::achievements::admin_grant_by_name),
        )
        .route(
            "/api/v2/admin/achievements/{achievement_id}/by-username/{username}",
            delete(routes::v2::achievements::admin_revoke_by_name),
        )
        .route(
            "/api/v2/admin/templates/backfill-previews",
            post(routes::v2::template_backfill::backfill_previews),
        )
        .route(
            "/api/v2/admin/config",
            get(routes::v2::admin_config::list_config),
        )
        .route(
            "/api/v2/admin/config/{key}",
            put(routes::v2::admin_config::update_config),
        )
        /* ════════════════════════════ V3 API ══════════════════════════════
         * Split identity model: users = Account, site_identities + provider_links
         * hold per-platform connections. */
        // --- auth: site attach-or-create, session info, refresh, logout ----
        .route("/api/v3/auth/site", post(routes::v3::auth::site))
        .route("/api/v3/auth/session", get(routes::v3::auth::session))
        .route("/api/v3/auth/refresh", post(routes::v3::auth::refresh))
        .route("/api/v3/auth/logout", post(routes::v3::auth::logout))
        // --- templates: V3 CRUD with the-wall-dev/2 canonical document ------
        .route("/api/v3/templates", get(routes::v3::templates::list))
        .route("/api/v3/templates/new", post(routes::v3::templates::create))
        .route(
            "/api/v3/templates/{id}",
            get(routes::v3::templates::get).delete(routes::v3::templates::delete),
        )
        .route(
            "/api/v3/templates/{id}/verify",
            post(routes::v3::templates::verify),
        )
        .route(
            "/api/v3/templates/{id}/wall-dev",
            get(routes::v3::templates::wall_dev),
        )
        .route(
            "/api/v3/templates/{id}/charity",
            get(routes::v3::templates::charity),
        )
        .route(
            "/api/v3/admin/templates/backfill-documents",
            post(routes::v3::templates::backfill),
        )
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = env::var("PORT").unwrap_or_else(|_| "3080".to_string());
    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind address");

    info!("Server listening on {}", addr);

    axum::serve(listener, app).await.expect("Server error");
}
