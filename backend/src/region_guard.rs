//! Protected-region guard.
//!
//! Server-side twin of the extension's local protection watch: for every
//! enabled `protected_regions` row whose recheck time is due, fetch the live
//! tiles covering the rect, diff against the stored reference PNG (painted
//! reference cells only — transparent cells were unpainted at capture time
//! and stay free), and update last_ok/last_broken_pct.
//!
//! On an ok→broken transition: drop a `clan_alert` mailbox item (when the
//! region is clan-scoped) and ping the Telegram admins with a rich message.
//! Recovery (broken→ok) sends a quieter follow-up so the alert thread has
//! closure. Tile fetching reuses crate::grief's window compositor.

use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use sqlx::PgPool;
use tokio::time::{MissedTickBehavior, interval};
use uuid::Uuid;

use crate::sites::{Source, config_for};
use crate::telegram_rich::{esc, send_rich_html};
use crate::{NotifyTargets, OAuthConfig};

const TICK: Duration = Duration::from_secs(60);
const BATCH: i64 = 8;
/// Same colour tolerance as the client diff core (sum of |ΔRGB|).
const TOL: i32 = 24;

#[derive(Debug, sqlx::FromRow)]
struct DueRegion {
    id: Uuid,
    clan_id: Option<Uuid>,
    name: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    tolerance_pct: f32,
    ref_png: String,
    last_ok: bool,
}

pub fn spawn(pool: PgPool, oauth: OAuthConfig, notify: NotifyTargets) {
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let mut t = interval(TICK);
        t.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            t.tick().await;
            if let Err(e) = tick(&pool, &client, &oauth, &notify).await {
                tracing::warn!("region guard tick: {e}");
            }
        }
    });
}

async fn tick(
    pool: &PgPool,
    client: &reqwest::Client,
    oauth: &OAuthConfig,
    notify: &NotifyTargets,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let due: Vec<DueRegion> = sqlx::query_as(
        r#"SELECT id, clan_id, name, x, y, w, h, tolerance_pct, ref_png, last_ok
             FROM protected_regions
            WHERE enabled = TRUE
              AND status = 'approved'
              AND (last_checked_at IS NULL
                   OR last_checked_at < NOW() - (check_interval || ' seconds')::interval)
            ORDER BY last_checked_at NULLS FIRST
            LIMIT $1"#,
    )
    .bind(BATCH)
    .fetch_all(pool)
    .await?;

    for r in due {
        match check_one(&r).await {
            Ok(broken_pct) => {
                let ok = broken_pct <= r.tolerance_pct;
                let _ = sqlx::query(
                    r#"UPDATE protected_regions
                          SET last_checked_at = NOW(), last_broken_pct = $2, last_ok = $3
                        WHERE id = $1"#,
                )
                .bind(r.id)
                .bind(broken_pct)
                .bind(ok)
                .execute(pool)
                .await;

                if r.last_ok && !ok {
                    alert(pool, client, oauth, notify, &r, broken_pct, true).await;
                } else if !r.last_ok && ok {
                    alert(pool, client, oauth, notify, &r, broken_pct, false).await;
                }
            }
            Err(e) => {
                tracing::warn!("region {} check failed: {e}", r.id);
                let _ = sqlx::query(
                    "UPDATE protected_regions SET last_checked_at = NOW() WHERE id = $1",
                )
                .bind(r.id)
                .execute(pool)
                .await;
            }
        }
    }
    Ok(())
}

/// Percentage of painted reference cells that no longer match the wall.
async fn check_one(r: &DueRegion) -> Result<f32, String> {
    let reference = decode_data_url(&r.ref_png)?.to_rgba8();
    let cfg = config_for(Source::default());
    let wall = crate::wall_tiles::fetch_wall_window(
        cfg.tile_base,
        r.x.max(0) as u32,
        r.y.max(0) as u32,
        r.w as u32,
        r.h as u32,
    )
    .await?
    .to_rgba8();

    let mut total = 0u64;
    let mut broken = 0u64;
    let n = reference.width().min(wall.width());
    let m = reference.height().min(wall.height());
    for y in 0..m {
        for x in 0..n {
            let rp = reference.get_pixel(x, y);
            if rp[3] < 128 {
                continue; // unpainted at capture — not protected
            }
            total += 1;
            let wp = wall.get_pixel(x, y);
            let d = (rp[0] as i32 - wp[0] as i32).abs()
                + (rp[1] as i32 - wp[1] as i32).abs()
                + (rp[2] as i32 - wp[2] as i32).abs();
            if d > TOL {
                broken += 1;
            }
        }
    }
    if total == 0 {
        return Ok(0.0);
    }
    Ok(100.0 * broken as f32 / total as f32)
}

async fn alert(
    pool: &PgPool,
    client: &reqwest::Client,
    oauth: &OAuthConfig,
    notify: &NotifyTargets,
    r: &DueRegion,
    broken_pct: f32,
    violated: bool,
) {
    let (title, body) = if violated {
        (
            "Protected region under attack".to_string(),
            format!(
                "\"{}\" at ({}, {}) {}×{} is {:.1}% broken (tolerance {:.1}%).",
                r.name, r.x, r.y, r.w, r.h, broken_pct, r.tolerance_pct
            ),
        )
    } else {
        (
            "Protected region restored".to_string(),
            format!("\"{}\" is back within tolerance ({:.1}% broken).", r.name, broken_pct),
        )
    };

    if let Some(clan_id) = r.clan_id {
        let _ = sqlx::query(
            r#"INSERT INTO mailbox_items (id, kind, sender_id, recipient_clan_id, title, body, payload)
               VALUES (gen_random_uuid(), 'clan_alert', NULL, $1, $2, $3,
                       jsonb_build_object('region_id', $4::text,
                                          'broken_pct', $5::real,
                                          'kind', 'region_guard'))"#,
        )
        .bind(clan_id)
        .bind(&title)
        .bind(&body)
        .bind(r.id)
        .bind(broken_pct)
        .execute(pool)
        .await;
    }

    if let Some(tok) = oauth.telegram_bot_token.as_deref() {
        let icon = if violated { "🚨" } else { "✅" };
        let html = format!(
            "<h3>{icon} {}</h3><p>{}</p><footer>region {} · <tg-time unix=\"{}\" format=\"DT\">now</tg-time></footer>",
            esc(&title),
            esc(&body),
            r.id,
            chrono::Utc::now().timestamp(),
        );
        for chat in &notify.telegram_admin_ids {
            if let Err(e) = send_rich_html(client, tok, chat, &html, !violated).await {
                tracing::warn!("region alert to {chat}: {e}");
            }
        }
    }

    // Additive: fan out to all bot_subscriptions of kind 'region' (self-contained
    // plain sender; admin telegram + clan_alert mailbox above are untouched).
    let sub_title = format!("🛡 Region {}", r.name);
    let sub_body = format!(
        "{} — {:.1}% broken",
        if violated { "UNDER ATTACK" } else { "recovered" },
        broken_pct
    );
    crate::bots::outbound::deliver_kind(pool, client, oauth, "region", &sub_title, &sub_body).await;
}

fn decode_data_url(url: &str) -> Result<image::DynamicImage, String> {
    let comma = url.find(',').ok_or("data url: no comma")?;
    if !url[..comma].contains(";base64") {
        return Err("data url: only base64 supported".into());
    }
    let bytes = BASE64
        .decode(url[comma + 1..].as_bytes())
        .map_err(|e| e.to_string())?;
    image::load_from_memory(&bytes).map_err(|e| e.to_string())
}
