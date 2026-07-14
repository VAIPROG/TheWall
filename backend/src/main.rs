mod auth;
mod bot_commands;
mod bots;
mod config;
mod bot_core;
mod discord_commands;
mod discord_gateway;
mod error_envelope;
mod formats;
mod guild_cache;
mod http_error;
mod models;
mod owner_seed;
mod region_guard;
mod reminder_worker;
mod routes;
mod session_cache;
mod signals;
mod sites;
mod snapshot_worker;
mod telegram_rich;
mod wall_tiles;

use axum::{
    Router,
    routing::{delete, get, patch, post, put},
};
use sqlx::postgres::PgPoolOptions;
use std::env;
use crate::config::AppConfig;
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::PgPool,
    pub config: AppConfig,
    pub started_at: std::time::SystemTime,
    pub session_cache: std::sync::Arc<crate::session_cache::SessionCache>,
    pub guild_cache: std::sync::Arc<crate::guild_cache::GuildCache>,
}

// Re-export config types so the rest of the crate can keep using
// `crate::OAuthConfig` etc. while the canonical definitions live in `config.rs`.
pub use crate::config::{LimitsConfig, NotifyTargets, OAuthConfig};

/// One boot-time pass over the optional feature knobs: every unset value
/// logs a warning naming the feature it turns off. Loud beats silent — a
/// missing var here is the difference between "bot offline, no idea why" and
/// a one-line answer in the journal.
fn warn_unset_config(config: &AppConfig) {
    let checks: &[(&str, bool, &str)] = &[
        ("TELEGRAM_BOT_TOKEN", config.oauth.telegram_bot_token.is_some(),
         "Telegram bot disabled (snapshots, DMs, admin commands)"),
        ("TELEGRAM_CLIENT_ID", config.oauth.telegram_client_id.is_some(),
         "Telegram OAuth linking/sign-in disabled (due missing Client ID)"),
        ("TELEGRAM_CLIENT_SECRET", config.oauth.telegram_client_secret.is_some(),
         "Telegram OAuth linking/sign-in disabled (due missing Client Secret)"),
        ("DISCORD_CLIENT_ID", config.oauth.discord_client_id.is_some(),
         "Discord OAuth linking/sign-in disabled (due missing Client ID)"),
        ("DISCORD_CLIENT_SECRET", config.oauth.discord_client_secret.is_some(),
         "Discord OAuth linking/sign-in disabled (due missing Client Secret)"),
        ("GITHUB_CLIENT_ID", config.oauth.github_client_id.is_some(),
         "GitHub OAuth linking/sign-in disabled (due missing Client ID)"),
        ("GITHUB_CLIENT_SECRET", config.oauth.github_client_secret.is_some(),
         "GitHub OAuth linking/sign-in disabled (due missing Client Secret)"),
        ("DISCORD_BOT_TOKEN", config.oauth.discord_bot_token.is_some(),
         "Discord bot disabled (gateway presence, DMs, slash registration)"),
        ("DISCORD_APPLICATION_ID", config.oauth.discord_application_id.is_some(),
         "Discord slash-command registration disabled"),
        ("DISCORD_PUBLIC_KEY", config.oauth.discord_public_key.is_some(),
         "Discord interactions webhook disabled — the portal's endpoint URL check will fail with 503"),
        ("TELEGRAM_NOTIFY_USER_ID", config.notify.telegram_user_id.is_some(),
         "Telegram snapshot/alert DMs disabled"),
        ("TELEGRAM_NOTIFY_CHANNEL_ID", config.notify.telegram_channel_id.is_some(),
         "Telegram channel snapshots disabled"),
        ("DISCORD_NOTIFY_USER_ID", config.notify.discord_user_id.is_some(),
         "Discord snapshot/alert DMs disabled"),
        ("TELEGRAM_ADMIN_IDS", !config.notify.telegram_admin_ids.is_empty(),
         "no Telegram bot admins seeded"),
        ("DISCORD_ADMIN_IDS", !config.notify.discord_admin_ids.is_empty(),
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
    crate::config::load_env_file();
    routes::meta::boot();

    let config = AppConfig::load();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&config.database_url)
        .await
        .expect("Failed to connect to database");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run database migrations");

    // Seed the first owner from env if the DB is empty and WALL_OWNER_SEED is set.
    owner_seed::seed_owner_if_needed(&pool, &config).await;

    // Loud config audit: name every optional feature that's off and why.
    warn_unset_config(&config);

    // Periodic full-wall snapshot worker — see `snapshot_worker.rs`. Also
    // pulls the signal feed each tick.
    snapshot_worker::spawn(pool.clone(), config.oauth.clone(), config.notify.clone());
    // Protected-region guard: server-side state verification + alerts.
    region_guard::spawn(pool.clone(), config.oauth.clone(), config.notify.clone());
    // Telegram admin command bot (/help /status /snapshot /logs /regions).
    bot_commands::spawn(pool.clone(), config.oauth.clone(), config.notify.clone());
    // Paint refill reminders: 10s sweep, DM delivery via linked channels.
    reminder_worker::spawn(pool.clone(), config.oauth.clone());
    // Discord slash-command registration (commands answered via the
    // /api/v2/discord/interactions webhook below).
    discord_commands::register_commands(config.oauth.clone());

    let state = AppState {
        pool,
        config,
        started_at: std::time::SystemTime::now(),
        session_cache: std::sync::Arc::new(crate::session_cache::SessionCache::new()),
        guild_cache: std::sync::Arc::new(crate::guild_cache::GuildCache::new()),
    };

    // Discord gateway: keeps the bot's presence Online and serves slash
    // commands as a fallback when the portal has no Interactions Endpoint URL.
    discord_gateway::spawn(state.clone());

    // CORS is handled by nginx — don't add a CorsLayer here or headers will duplicate.

    let legacy_api = Router::new()
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
        .route("/api/v3/meta", get(routes::meta::get_meta))
        .route("/api/v3/health", get(routes::meta::health_check))
        .route("/api/v3/who-is-the-dev", get(routes::who::who_is_the_dev))
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
    ;

    let v3_api = Router::new()
        /* ════════════════════════════ V3 API ══════════════════════════════
         * Split identity model: users = Account, site_identities + provider_links
         * hold per-platform connections. */
        // --- auth: site attach-or-create, session info, refresh, logout ----
        .route("/api/v3/auth/site", post(routes::v3::auth::site))
        .route("/api/v3/auth/session", get(routes::v3::auth::session))
        .route("/api/v3/auth/refresh", post(routes::v3::auth::refresh))
        .route("/api/v3/auth/logout", post(routes::v3::auth::logout))
        .route("/api/v3/auth/merge/initiate", post(routes::v3::auth::merge_initiate))
        .route("/api/v3/users/me/merge", post(routes::v3::auth::merge))
        .route("/api/v3/auth/oauth/{provider}/start", get(routes::v3::auth::oauth::start))
        .route("/api/v3/auth/oauth/{provider}/callback", post(routes::v3::auth::oauth::callback))
        // --- mnemonic recovery: generate phrase (auth), recover account (public) ---
        .route("/api/v3/users/me/recovery/phrase", post(routes::v3::auth::generate_phrase))
        .route("/api/v3/auth/recover", post(routes::v3::auth::recover))
        // --- site-identity management: list + unlink ---
        .route("/api/v3/users/me/site-identities", get(routes::v3::users::list_site_identities))
        .route("/api/v3/users/me/site-identities/{source}", delete(routes::v3::users::unlink_site_identity))
        .route("/api/v3/users/me/appeal", post(routes::v3::users::submit_appeal))
        // --- V3 users: profiles, avatar, socials, keys, block-list ------------
        .route("/api/v3/users/me", get(routes::v3::users::get_me).patch(routes::v3::users::update_me))
        .route("/api/v3/users/me/avatar", post(routes::v3::users::upload_avatar).delete(routes::v3::users::delete_avatar))
        .route("/api/v3/users/me/socials", get(routes::v3::users::get_my_socials).post(routes::v3::users::add_my_social))
        .route("/api/v3/users/me/socials/{provider}", patch(routes::v3::users::update_my_social).delete(routes::v3::users::delete_my_social))
        .route("/api/v3/users/me/keys", get(routes::v3::users::get_my_keys).post(routes::v3::users::create_key))
        .route("/api/v3/users/me/keys/{id}", get(routes::v3::users::get_key).patch(routes::v3::users::update_key).delete(routes::v3::users::delete_key))
        .route("/api/v3/users/me/keys/{id}/request-higher-limits", post(routes::v3::users::request_higher_limits))
        .route("/api/v3/users/me/block-list", get(routes::v3::users::get_block_list))
        .route("/api/v3/users/resolve", post(routes::v3::users::resolve_users))
        .route("/api/v3/users/{user_ref}", get(routes::v3::users::get_user_by_ref))
        .route("/api/v3/users/{user_ref}/socials", get(routes::v3::users::get_user_socials))
        .route("/api/v3/users/{user_ref}/templates", get(routes::v3::users::get_user_templates))
        .route("/api/v3/users/{user_ref}/block", post(routes::v3::users::block_user))
        .route("/api/v3/users/{user_ref}/unblock", post(routes::v3::users::unblock_user))
        // --- templates: V3 CRUD with the-wall-dev/2 canonical document ------
        .route("/api/v3/templates", get(routes::v3::templates::list))
        .route("/api/v3/templates/new", post(routes::v3::templates::create))
        .route(
            "/api/v3/templates/{id}",
            get(routes::v3::templates::get)
                .patch(routes::v3::templates::update)
                .delete(routes::v3::templates::delete),
        )
        .route(
            "/api/v3/templates/{id}/verify",
            post(routes::v3::templates::verify),
        )
        .route(
            "/api/v3/templates/{id}/report",
            post(routes::v3::templates::report_template),
        )
        .route(
            "/api/v3/templates/{id}/pin",
            post(routes::v3::templates::pin).delete(routes::v3::templates::unpin),
        )
        .route(
            "/api/v3/templates/pinned",
            get(routes::v3::templates::list_pinned),
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
            "/api/v3/templates/{id}/png",
            get(routes::v3::templates::get_png),
        )
        .route(
            "/api/v3/templates/{id}/preview",
            get(routes::v3::templates::get_preview),
        )
        .route(
            "/api/v3/templates/{id}/animated",
            get(routes::v3::templates::get_animated),
        )
        .route(
            "/api/v3/admin/templates/backfill-documents",
            post(routes::v3::templates::backfill),
        )
        // --- V3 chats: unified chat model (global, clan, DM) ------------------
        .route("/api/v3/chats", get(routes::v3::chats::list_chats))
        // `/api/v3/chats/{id}` handles both a chat UUID and the literal keyword
        // `global` (resolved in get_chat_detail via resolve_chat_selector), so no
        // separate `/global` route is needed. Literal sub-paths like
        // `/global/modmail` still need their own routes (different handler).
        .route(
            "/api/v3/chats/global/modmail",
            get(routes::v3::chats::get_modmail).post(routes::v3::chats::send_modmail),
        )
        .route(
            "/api/v3/dm/{user_ref}",
            get(routes::v3::chats::get_dm_thread).post(routes::v3::chats::send_dm),
        )
        .route(
            "/api/v3/chats/{id}",
            get(routes::v3::chats::get_chat_detail),
        )
        .route(
            "/api/v3/chats/{id}/messages",
            get(routes::v3::chats::list_messages).post(routes::v3::chats::send_message),
        )
        .route(
            "/api/v3/chats/{cid}/messages/{mid}",
            axum::routing::patch(routes::v3::chats::edit_message)
                .delete(routes::v3::chats::delete_message),
        )
        .route(
            "/api/v3/chats/{cid}/messages/{mid}/reactions/{emoji}",
            axum::routing::put(routes::v3::chats::add_reaction)
                .delete(routes::v3::chats::remove_reaction),
        )
        .route(
            "/api/v3/chats/{cid}/messages/{mid}/report",
            post(routes::v3::chats::report_message),
        )
        .route(
            "/api/v3/chats/{cid}/messages/{mid}/pin",
            post(routes::v3::chats::pin_message).delete(routes::v3::chats::unpin_message),
        )
        .route(
            "/api/v3/chats/{cid}/read",
            post(routes::v3::chats::mark_read),
        )
        // --- V3 clans: core CRUD (list, create, get, update) -----------------
        .route(
            "/api/v3/clans",
            get(routes::v3::clans::list_clans),
        )
        .route(
            "/api/v3/clans/new",
            post(routes::v3::clans::create_clan),
        )
        .route(
            "/api/v3/clans/{id}",
            get(routes::v3::clans::get_clan).patch(routes::v3::clans::update_clan),
        )
        // --- V3 clans: Discord owned-guilds + site-clan suggestion ------------
        .route(
            "/api/v3/clans/discord/owned-guilds",
            get(routes::v3::clans::owned_guilds),
        )
        .route(
            "/api/v3/clans/site-suggestion",
            get(routes::v3::clans::site_suggestion),
        )
        .route(
            "/api/v3/clans/from-guild",
            post(routes::v3::clans::create_from_guild),
        )
        .route(
            "/api/v3/clans/from-site",
            post(routes::v3::clans::create_from_site),
        )
        .route(
            "/api/v3/clans/{id}/verify-ownership",
            post(routes::v3::clans::verify_ownership),
        )
        // --- V3 clans: members roster + role/kick hierarchy ------------------
        .route(
            "/api/v3/clans/{id}/members",
            get(routes::v3::clans::list_members),
        )
        .route(
            "/api/v3/clans/{cid}/members/{uid}",
            get(routes::v3::clans::get_member)
                .patch(routes::v3::clans::update_member_role)
                .delete(routes::v3::clans::kick_member),
        )
        // --- V3 clans: lifecycle (leave, disband) ----------------------------
        .route(
            "/api/v3/clans/{id}/leave",
            post(routes::v3::clans::leave_clan),
        )
        .route(
            "/api/v3/clans/{id}/disband",
            post(routes::v3::clans::disband_clan),
        )
        // --- V3 clans: invites -----------------------------------------------
        .route(
            "/api/v3/clans/{id}/invites",
            get(routes::v3::clans::list_invites).post(routes::v3::clans::create_invite),
        )
        .route(
            "/api/v3/clans/{cid}/invites/{iid}",
            delete(routes::v3::clans::revoke_invite),
        )
        // --- V3 clans: join + staff-role applications ------------------------
        .route(
            "/api/v3/clans/{id}/join",
            post(routes::v3::clans::join_clan),
        )
        .route(
            "/api/v3/clans/{cid}/apply/{role}",
            post(routes::v3::clans::apply_for_role),
        )
        // --- V3 clans: join-application review --------------------------------
        .route(
            "/api/v3/clans/{id}/applications",
            get(routes::v3::clans::list_applications),
        )
        .route(
            "/api/v3/clans/{cid}/applications/{aid}/review",
            post(routes::v3::clans::review_application),
        )
        // --- V3 clans: settings, report, clan templates, restrictions ---------
        .route(
            "/api/v3/clans/{id}/settings",
            get(routes::v3::clans::get_settings).patch(routes::v3::clans::update_settings),
        )
        .route(
            "/api/v3/clans/{id}/report",
            post(routes::v3::clans::report_clan),
        )
        .route(
            "/api/v3/clans/{id}/templates",
            get(routes::v3::clans::list_clan_templates),
        )
        .route(
            "/api/v3/clans/{id}/restrictions",
            get(routes::v3::clans::list_clan_restrictions),
        )
        // --- V3 notifications --------------------------------------------------
        .route("/api/v3/notifications", get(routes::v3::notifications::list_notifications))
        .route("/api/v3/notifications/ack", post(routes::v3::notifications::ack_notifications))
        .route("/api/v3/notifications/ack/all", post(routes::v3::notifications::ack_all_notifications))
        .route(
            "/api/v3/notifications/settings",
            get(routes::v3::notifications::get_settings)
                .patch(routes::v3::notifications::update_settings),
        )
        .route(
            "/api/v3/notifications/{id}",
            get(routes::v3::notifications::get_notification)
                .delete(routes::v3::notifications::dismiss_notification),
        )
        // --- V3 telemetry: events, logs, health, metrics -----------------------
        .route("/api/v3/telemetry/events", post(routes::v3::telemetry::submit_events))
        .route("/api/v3/telemetry/logs", post(routes::v3::telemetry::upload_logs).get(routes::v3::telemetry::query_logs))
        .route("/api/v3/telemetry/logs/export", get(routes::v3::telemetry::export_logs))
        .route("/api/v3/telemetry/health", get(routes::v3::telemetry::health_check))
        .route("/api/v3/telemetry/metrics", get(routes::v3::telemetry::get_metrics))
        // --- V3 admin: user management + audit --------------------------------
        .route("/api/v3/admin/users/{user_ref}", get(routes::v3::admin::admin_get_user).patch(routes::v3::admin::admin_update_user))
        .route("/api/v3/admin/users/{user_ref}/ban", post(routes::v3::admin::admin_ban_user).delete(routes::v3::admin::admin_unban_user))
        .route("/api/v3/admin/users/{user_ref}/mute", post(routes::v3::admin::admin_mute_user).delete(routes::v3::admin::admin_unmute_user))
        .route("/api/v3/admin/users/{user_ref}/promote", post(routes::v3::admin::admin_promote_user))
        .route("/api/v3/admin/users/{user_ref}/wipeout", post(routes::v3::admin::admin_wipeout_user))
        .route("/api/v3/admin/users/{user_ref}/remove-from-clan", post(routes::v3::admin::admin_remove_from_clan))
        .route("/api/v3/admin/users/{user_ref}/reset-avatar", post(routes::v3::admin::admin_reset_avatar))
        .route("/api/v3/admin/users/{user_ref}/reset-username", post(routes::v3::admin::admin_reset_username))
        .route("/api/v3/admin/users/{user_ref}/sessions", get(routes::v3::admin::admin_get_user_sessions).delete(routes::v3::admin::admin_terminate_user_sessions))
        .route("/api/v3/admin/users/{user_ref}/notes", get(routes::v3::admin::admin_get_user_notes).post(routes::v3::admin::admin_add_user_note))
        .route("/api/v3/admin/users/{user_ref}/impersonate", post(routes::v3::admin::admin_impersonate_user))
        .route("/api/v3/admin/audit", get(routes::v3::admin::admin_audit_log))
        .route("/api/v3/admin/config", get(routes::v3::admin::admin_get_config).patch(routes::v3::admin::admin_update_config))
        .route("/api/v3/admin/maintenance", get(routes::v3::admin::admin_get_maintenance).post(routes::v3::admin::admin_set_maintenance))
        .route("/api/v3/admin/broadcast", post(routes::v3::admin::admin_broadcast))
        .route("/api/v3/admin/metrics", get(routes::v3::admin::admin_metrics))
        .route("/api/v3/admin/shutdown", post(routes::v3::admin::admin_shutdown))
        .route("/api/v3/admin/restart", post(routes::v3::admin::admin_restart))
        // --- V3 moderation: report queue + template approval + audit log ------
        .route(
            "/api/v3/moderation/reports",
            get(routes::v3::moderation::list_reports),
        )
        .route(
            "/api/v3/moderation/reports/{id}",
            get(routes::v3::moderation::get_report)
                .patch(routes::v3::moderation::update_report),
        )
        .route(
            "/api/v3/moderation/reports/{id}/resolve",
            post(routes::v3::moderation::resolve_report),
        )
        .route(
            "/api/v3/moderation/reports/{id}/dismiss",
            post(routes::v3::moderation::dismiss_report),
        )
        .route(
            "/api/v3/moderation/queue",
            get(routes::v3::moderation::get_queue),
        )
        .route(
            "/api/v3/moderation/queue/{tid}/approve",
            post(routes::v3::moderation::approve_template),
        )
        .route(
            "/api/v3/moderation/queue/{tid}/reject",
            post(routes::v3::moderation::reject_template),
        )
        .route(
            "/api/v3/moderation/audit-log",
            get(routes::v3::moderation::get_audit_log),
        )
        .route(
            "/api/v3/moderation/clans/{id}/takedown",
            post(routes::v3::moderation::takedown_clan),
        )
        .route(
            "/api/v3/moderation/clans/{id}/unlock",
            post(routes::v3::moderation::unlock_clan),
        )
        // --- V3 restrictions: granular sanctions CRUD -------------------------
        .route(
            "/api/v3/restrictions",
            get(routes::v3::moderation::list_restrictions)
                .post(routes::v3::moderation::create_restriction),
        )
        .route(
            "/api/v3/restrictions/{id}",
            get(routes::v3::moderation::get_restriction)
                .patch(routes::v3::moderation::update_restriction)
                .delete(routes::v3::moderation::delete_restriction),
        )
        .route(
            "/api/v3/users/{user_ref}/restrictions",
            get(routes::v3::moderation::user_restrictions),
        )
        // --- V3 feed: unified snapshots, signals, announcements ----------
        .route("/api/v3/feed", get(routes::v3::feed::list))
        .route("/api/v3/feed/{id}", get(routes::v3::feed::get_one))
        .route("/api/v3/feed/{id}/notes", get(routes::v3::feed::list_notes))
        .route("/api/v3/admin/feed", post(routes::v3::feed::create))
        .route("/api/v3/admin/feed/{id}/notes", post(routes::v3::feed::upsert_note))
        .route("/api/v3/admin/feed/{id}/notes/{lang}", delete(routes::v3::feed::delete_note))
        // --- V3 achievements --------------------------------------------------
        .route(
            "/api/v3/users/me/achievements",
            get(routes::v3::achievements::list_my_achievements),
        )
        .route(
            "/api/v3/users/me/achievements/recheck",
            post(routes::v3::achievements::recheck_my_achievements),
        )
        .route(
            "/api/v3/users/me/achievements/event",
            post(routes::v3::achievements::record_event),
        )
        .route(
            "/api/v3/users/{user_ref}/achievements",
            get(routes::v3::achievements::list_user_achievements),
        )
        .route(
            "/api/v3/admin/achievements/catalog",
            get(routes::v3::achievements::admin_catalog),
        )
        .route(
            "/api/v3/admin/achievements/grants",
            get(routes::v3::achievements::admin_grants),
        )
        .route(
            "/api/v3/admin/achievements/{id}/grant",
            post(routes::v3::achievements::admin_grant),
        )
        .route(
            "/api/v3/admin/achievements/{id}/revoke/{user_id}",
            delete(routes::v3::achievements::admin_revoke),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            routes::v3::middleware::auth_and_ban_middleware,
        ))
        // Rewrite plain-text error bodies into the structured
        // `{ error: { code, message, traceId } }` envelope (v6.1.3). Placed
        // OUTSIDE auth (so it also catches the 401/403 the auth layer emits)
        // but INSIDE the compression layer (so the JSON it produces is what
        // gets compressed — otherwise it would see a compressed body and
        // corrupt it).
        .layer(axum::middleware::from_fn(
            error_envelope::error_envelope_middleware,
        ))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let legacy_api = legacy_api
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            routes::v3::deprecation::v1_v2_deprecation_middleware,
        ))
        // Envelope OUTSIDE the deprecation middleware: legacy handler text
        // errors are wrapped after deprecation has passed them through, while
        // the deprecation middleware's own JSON error bodies (410/403) already
        // have a JSON content-type and so pass through the envelope untouched.
        // Legacy has no compression layer, so ordering vs. compression is moot.
        .layer(axum::middleware::from_fn(
            error_envelope::error_envelope_middleware,
        ))
        .with_state(state.clone());

    let app = Router::new()
        .merge(legacy_api)
        .merge(v3_api);

    let addr = format!("0.0.0.0:{}", state.config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind address");

    info!("Server listening on {}", addr);

    axum::serve(listener, app).await.expect("Server error");
}
