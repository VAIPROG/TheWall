//! Platform-neutral data layer for the admin bots.
//!
//! Telegram (long-poll, rich HTML) and Discord (interactions webhook,
//! markdown) answer the same questions; the SQL lives here exactly once and
//! each transport formats the plain structs its own way.

use sqlx::PgPool;

pub struct StatusData {
    pub users: i64,
    pub sessions: i64,
    pub templates: i64,
    pub regions_enabled: i64,
    pub regions_broken: i64,
    pub last_snapshot: Option<chrono::DateTime<chrono::Utc>>,
}

pub struct UserCountData {
    pub users: i64,
    pub active_today: i64,
    pub sessions: i64,
}

pub struct SnapshotLink {
    pub size: String,
    pub url: Option<String>,
    pub at: chrono::DateTime<chrono::Utc>,
}

pub struct EventRow {
    pub title: String,
    pub body: String,
    pub at: chrono::DateTime<chrono::Utc>,
}

pub struct RegionOverview {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub tolerance_pct: f32,
    pub broken_pct: f32,
    pub ok: bool,
    pub enabled: bool,
    pub status: String,
}

async fn scalar(pool: &PgPool, q: &str) -> i64 {
    sqlx::query_scalar(q).fetch_one(pool).await.unwrap_or(0)
}

pub async fn status_data(pool: &PgPool) -> StatusData {
    StatusData {
        users: scalar(pool, "SELECT COUNT(*) FROM users").await,
        sessions: scalar(pool, "SELECT COUNT(*) FROM sessions WHERE expires_at > NOW()").await,
        templates: scalar(pool, "SELECT COUNT(*) FROM templates").await,
        regions_enabled: scalar(pool, "SELECT COUNT(*) FROM protected_regions WHERE enabled").await,
        regions_broken: scalar(
            pool,
            "SELECT COUNT(*) FROM protected_regions WHERE enabled AND NOT last_ok",
        )
        .await,
        last_snapshot: sqlx::query_scalar(
            "SELECT MAX(occurred_at) FROM feed_events WHERE event_type = 'snapshot'",
        )
        .fetch_one(pool)
        .await
        .unwrap_or(None),
    }
}

pub async fn user_count_data(pool: &PgPool) -> UserCountData {
    UserCountData {
        users: scalar(pool, "SELECT COUNT(*) FROM users").await,
        active_today: scalar(
            pool,
            "SELECT COUNT(DISTINCT user_id) FROM sessions \
             WHERE last_activity > NOW() - INTERVAL '1 day'",
        )
        .await,
        sessions: scalar(pool, "SELECT COUNT(*) FROM sessions WHERE expires_at > NOW()").await,
    }
}

pub async fn latest_snapshot(pool: &PgPool) -> Vec<SnapshotLink> {
    let row: Option<(serde_json::Value, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        r#"SELECT payload, occurred_at
             FROM feed_events
            WHERE event_type = 'snapshot'
            ORDER BY occurred_at DESC
            LIMIT 1"#,
    )
    .fetch_optional(pool)
    .await
    .unwrap_or_default();

    let Some((payload, at)) = row else {
        return Vec::new();
    };

    let sizes = payload.get("sizes").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let order = ["small", "medium", "large"];
    let mut out = Vec::new();
    for size in order {
        if let Some(obj) = sizes.get(size).and_then(|v| v.as_object()) {
            let url = obj
                .get("telegramUrl")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    obj.get("discordUrl")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                })
                .map(String::from);
            out.push(SnapshotLink {
                size: size.to_string(),
                url,
                at,
            });
        }
    }
    out
}

pub async fn recent_events(pool: &PgPool, n: i64) -> Vec<EventRow> {
    let n = n.clamp(1, 50);
    sqlx::query_as::<_, (String, String, chrono::DateTime<chrono::Utc>)>(
        r#"SELECT title, COALESCE(body, ''), created_at
             FROM mailbox_items
            WHERE kind IN ('clan_alert', 'mod_alert')
            ORDER BY created_at DESC LIMIT $1"#,
    )
    .bind(n)
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|(title, body, at)| EventRow { title, body, at })
    .collect()
}

pub async fn regions_overview(pool: &PgPool) -> Vec<RegionOverview> {
    sqlx::query_as::<_, (String, i32, i32, i32, i32, f32, f32, bool, bool, String)>(
        r#"SELECT name, x, y, w, h, tolerance_pct, last_broken_pct, last_ok, enabled, status
             FROM protected_regions ORDER BY captured_at DESC LIMIT 30"#,
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(
        |(name, x, y, w, h, tolerance_pct, broken_pct, ok, enabled, status)| RegionOverview {
            name,
            x,
            y,
            w,
            h,
            tolerance_pct,
            broken_pct,
            ok,
            enabled,
            status,
        },
    )
    .collect()
}

/// Human state label shared by both transports (emoji travel fine in both).
pub fn region_state_label(r: &RegionOverview) -> &'static str {
    if r.status == "pending" {
        "🕓 pending"
    } else if r.status == "rejected" {
        "🚫 rejected"
    } else if !r.enabled {
        "⏸ off"
    } else if r.ok {
        "🟢 ok"
    } else {
        "🔴 BROKEN"
    }
}

/// Is this principal allowed to run admin commands on `platform`?
pub async fn is_bot_admin(pool: &PgPool, platform: &str, external_id: &str) -> bool {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM bot_admins WHERE platform = $1 AND external_id = $2",
    )
    .bind(platform)
    .bind(external_id)
    .fetch_one(pool)
    .await
    .map(|c| c > 0)
    .unwrap_or(false)
}

/* ----------------------- linked-user commands ---------------------------- */

/// Resolve a platform principal to a Wall user. This is what lets ANY linked
/// account (not just admins) run /me and /clan-chat.
pub async fn find_user_by_platform(
    pool: &PgPool,
    platform: &str,
    external_id: &str,
) -> Option<(uuid::Uuid, String)> {
    let q = match platform {
        "telegram" => "SELECT id, username FROM users WHERE telegram_user_id = $1",
        "discord" => "SELECT id, username FROM users WHERE discord_id = $1",
        _ => return None,
    };
    sqlx::query_as(q)
        .bind(external_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

pub struct MeData {
    pub username: String,
    pub global_role: String,
    pub clan_name: Option<String>,
    pub clan_role: Option<String>,
    pub pixels_placed: i64,
    pub telegram_linked: bool,
    pub discord_linked: bool,
}

pub async fn me_data(pool: &PgPool, user_id: uuid::Uuid) -> Option<MeData> {
    let row =
        sqlx::query_as::<_, (String, String, Option<String>, Option<String>, bool, bool)>(
            r#"SELECT u.username, u.global_role,
                      cl.clan_name, cl.clan_role,
                      u.telegram_user_id IS NOT NULL,
                      u.discord_id IS NOT NULL
                 FROM users u
            LEFT JOIN LATERAL (
                      SELECT c.name AS clan_name, m.clan_role
                        FROM clan_memberships m
                        JOIN clans c ON c.id = m.clan_id
                       WHERE m.user_id = u.id AND m.active = TRUE
                       ORDER BY m.joined_at ASC LIMIT 1
                  ) cl ON TRUE
                WHERE u.id = $1"#,
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()?;
    let pixels: i64 =
        sqlx::query_scalar("SELECT COALESCE(pixels_placed, 0) FROM user_stats WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .unwrap_or(0);
    Some(MeData {
        username: row.0,
        global_role: row.1,
        clan_name: row.2,
        clan_role: row.3,
        pixels_placed: pixels,
        telegram_linked: row.4,
        discord_linked: row.5,
    })
}

pub struct ClanMessageRow {
    pub author: String,
    pub text: String,
    pub at: chrono::DateTime<chrono::Utc>,
}

/// First active clan of the user, or None.
async fn first_clan(pool: &PgPool, user_id: uuid::Uuid) -> Option<uuid::Uuid> {
    sqlx::query_scalar(
        r#"SELECT clan_id FROM clan_memberships
            WHERE user_id = $1 AND active = TRUE
            ORDER BY joined_at ASC LIMIT 1"#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

pub async fn clan_recent_messages(
    pool: &PgPool,
    user_id: uuid::Uuid,
    n: i64,
) -> Result<Vec<ClanMessageRow>, String> {
    let clan = first_clan(pool, user_id).await.ok_or("you are not in a clan")?;
    let rows: Vec<(String, String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        r#"SELECT author, text, created_at FROM clan_messages
            WHERE clan_id = $1 ORDER BY created_at DESC LIMIT $2"#,
    )
    .bind(clan)
    .bind(n.clamp(1, 25))
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .rev() // chronological for reading
        .map(|(author, text, at)| ClanMessageRow { author, text, at })
        .collect())
}

/// Post into the user's clan chat under their own name. The bot transports;
/// the message is the user's.
pub async fn clan_send_message(
    pool: &PgPool,
    user_id: uuid::Uuid,
    username: &str,
    text: &str,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("empty message".into());
    }
    if text.len() > 2000 {
        return Err("message too long (2000 max)".into());
    }
    let clan = first_clan(pool, user_id).await.ok_or("you are not in a clan")?;
    sqlx::query(
        r#"INSERT INTO clan_messages (id, user_id, clan_id, author, text, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())"#,
    )
    .bind(user_id)
    .bind(clan)
    .bind(username)
    .bind(text)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
