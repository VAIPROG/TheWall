//! Periodic snapshot worker.
//!
//! Each tick (default 5 min) we:
//!   1. Fetch a fresh copy of filianislost's brick-background.webp (cached
//!      between ticks). Resize it per layer so the pattern looks consistent
//!      across small/medium/large.
//!   2. Build three PNGs (large=layer 0, medium=layer 1, small=layer 2) by
//!      tiling brick-pattern first, then overlaying canvas tiles fetched
//!      from the tile server starting at (0,0) of each grid. Tiles past the
//!      wall edge are just absent → brick shows through, which matches the
//!      look on the site.
//!   3. Ship the three files together as a single Discord message + single
//!      Telegram media group (DM + public channel), keeping them grouped
//!      visually for viewers. Captions carry timestamp + size info.
//!   4. Persist URLs only (both message URL + direct CDN URL) — bytes never
//!      touch the DB.
//!   5. Refresh signal mirror at the end of the tick.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    NotifyTargets, OAuthConfig,
    sites::{Source, config_for},
};

const TILE: u32 = 256;
const BRICK_URL: &str = "https://filianislost.com/static/brick-background-hi.webp";

#[derive(Debug, Clone, Copy)]
pub enum Size {
    Small,
    Medium,
    Large,
}

impl Size {
    pub fn as_str(self) -> &'static str {
        match self {
            Size::Small => "small",
            Size::Medium => "medium",
            Size::Large => "large",
        }
    }
    pub fn layer(self) -> u32 {
        match self {
            Size::Small => 2,
            Size::Medium => 1,
            Size::Large => 0,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Size::Small => "S",
            Size::Medium => "M",
            Size::Large => "L",
        }
    }
    pub fn label_full(self) -> &'static str {
        match self {
            Size::Small => "Small",
            Size::Medium => "Medium",
            Size::Large => "Large",
        }
    }
}

fn fmt_bytes(n: usize) -> String {
    const KB: usize = 1024;
    const MB: usize = 1024 * 1024;
    if n >= MB {
        format!("{:.1} MB", n as f64 / MB as f64)
    } else if n >= KB {
        format!("{} KB", (n + KB - 1) / KB)
    } else {
        format!("{n} B")
    }
}

#[derive(Clone)]
struct BrickCache {
    inner: Arc<Mutex<Option<image::DynamicImage>>>,
}
impl BrickCache {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }
    fn get(&self) -> Option<image::DynamicImage> {
        self.inner.lock().unwrap().clone()
    }
    fn set(&self, img: image::DynamicImage) {
        *self.inner.lock().unwrap() = Some(img);
    }
}

pub fn spawn(pool: PgPool, oauth: OAuthConfig, notify: NotifyTargets) {
    if notify.discord_user_id.is_none()
        && notify.telegram_user_id.is_none()
        && notify.telegram_channel_id.is_none()
    {
        tracing::info!("snapshot_worker: no notify targets configured, not spawning");
        return;
    }
    tokio::spawn(async move {
        let brick = BrickCache::new();
        // First snapshot: run immediately so a freshly-deployed instance
        // doesn't sit silent for the first cadence interval. Subsequent
        // snapshots align to the wall clock — see `next_aligned_delay`.
        tokio::time::sleep(Duration::from_secs(10)).await;
        run_pass(&pool, &oauth, &notify, &brick).await;

        loop {
            let delay = next_aligned_delay(notify.snapshot_interval_secs);
            tracing::debug!(
                "snapshot_worker: sleeping {}s until next aligned tick",
                delay.as_secs()
            );
            tokio::time::sleep(delay).await;
            run_pass(&pool, &oauth, &notify, &brick).await;
        }
    });
}

/// Run one full snapshot pass plus the side-effect followups (signal mirror,
/// anti-grief scan). Each side-effect is logged but never aborts the loop —
/// a Telegram outage shouldn't stop us from taking the next snapshot.
async fn run_pass(
    pool: &PgPool,
    oauth: &OAuthConfig,
    notify: &NotifyTargets,
    brick: &BrickCache,
) {
    if let Err(e) = run_once(pool, oauth, notify, brick).await {
        tracing::warn!("snapshot_worker tick: {e}");
    }
    if let Err(e) = crate::signals::poll_once(pool).await {
        tracing::warn!("signals poll: {e}");
    }
    // Template anti-grief used to be kicked from here; it's been superseded
    // by the standalone protected-region guard (crate::region_guard), which
    // runs on its own schedule and needs no per-snapshot trigger.
}

/// Return the duration until the next wall-clock-aligned tick.
///
/// Example: with `interval = 240` (4 minutes) we fire at HH:00, HH:04, HH:08,
/// … From a current minute of 02:37 the next aligned slot is 04:00 (~1m23s
/// away). This keeps snapshots predictable across restarts — operators see
/// the same minutes-of-the-hour every day regardless of when the process
/// started.
fn next_aligned_delay(interval_secs: u64) -> Duration {
    let interval = interval_secs.max(60); // 1-minute floor, sanity
    let now = chrono::Utc::now().timestamp() as u64;
    // Floor to the previous slot, add one slot to get the next one. Guarantees
    // we never return 0 (which would burn CPU on a tight loop right after a
    // tick lands exactly on a slot).
    let next = (now / interval + 1) * interval;
    Duration::from_secs(next - now)
}

/// One full snapshot pass: build 3 sizes → send as one Discord message + one
/// Telegram media group per destination → persist URLs.
async fn run_once(
    pool: &PgPool,
    oauth: &OAuthConfig,
    notify: &NotifyTargets,
    brick: &BrickCache,
) -> Result<(), String> {
    let cfg = config_for(Source::Filianislost);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    // 1. Refresh brick texture if we don't have it yet.
    if brick.get().is_none() {
        if let Ok(b) = fetch_image(&client, BRICK_URL).await {
            brick.set(b);
        }
    }
    let brick_img = brick.get();

    // 2. Build all three sizes up-front so we can ship them together.
    let mut shots: Vec<BuiltShot> = Vec::with_capacity(3);
    for size in [Size::Small, Size::Medium, Size::Large] {
        match build_snapshot(
            &client,
            cfg.tile_base,
            cfg.width,
            cfg.height,
            size,
            brick_img.as_ref(),
        )
        .await
        {
            Ok((png, webp, w, h)) => shots.push(BuiltShot {
                size,
                png,
                webp,
                w,
                h,
            }),
            Err(e) => tracing::warn!("build_snapshot {}: {e}", size.as_str()),
        }
    }
    if shots.is_empty() {
        return Err("all sizes failed".into());
    }

    let stamp = chrono::Utc::now();
    // Sort so consumers always see [Small, Medium, Large] in this order — the
    // Telegram caption-on-last logic depends on Large being the final entry.
    shots.sort_by_key(|s| match s.size {
        Size::Small => 0,
        Size::Medium => 1,
        Size::Large => 2,
    });
    let line = |sz: Size| -> String {
        match shots.iter().find(|s| s.size.as_str() == sz.as_str()) {
            Some(s) => format!(
                "{} {}×{} ({})",
                sz.label_full(),
                s.w,
                s.h,
                fmt_bytes(s.png.len())
            ),
            None => format!("{} —", sz.label_full()),
        }
    };
    let caption = format!(
        "📸 The Wall · {ts}\n{l}\n{m}\n{s}",
        ts = stamp.format("%Y-%m-%d %H:%M:%S UTC"),
        l = line(Size::Large),
        m = line(Size::Medium),
        s = line(Size::Small),
    );
    let stamp_str = stamp.format("%Y%m%d_%H%M%S").to_string();

    // 3. Ship.
    //
    // Discord: one DM with up to 10 attachments. We parse the response's
    // attachments[] to recover the direct CDN URL per file — that's what
    // we persist as `discord_url`.
    let discord_cdn: HashMap<&'static str, String> = match (
        oauth.discord_bot_token.as_deref(),
        notify.discord_user_id.as_deref(),
    ) {
        (Some(tok), Some(uid)) => {
            match send_discord_album(&client, tok, uid, &caption, &stamp_str, &shots).await {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!("discord album: {e}");
                    HashMap::new()
                }
            }
        }
        _ => HashMap::new(),
    };

    // Telegram DM — opt-in only (TELEGRAM_SNAPSHOT_DM=on). The channel is the
    // broadcast target; spamming the operator's DMs every 4 minutes drowned
    // real alerts, and the admin bot's /snapshot serves the on-demand case.
    if notify.telegram_snapshot_dm {
        if let (Some(tok), Some(uid)) = (
            oauth.telegram_bot_token.as_deref(),
            notify.telegram_user_id.as_deref(),
        ) {
            if let Err(e) =
                send_telegram_album(&client, tok, uid, &caption, &stamp_str, &shots, None).await
            {
                tracing::warn!("telegram dm album: {e}");
            }
        }
    }

    // Telegram public channel — what we persist as `telegram_url`.
    let tg_channel: HashMap<&'static str, String> = match (
        oauth.telegram_bot_token.as_deref(),
        notify.telegram_channel_id.as_deref(),
    ) {
        (Some(tok), Some(cid)) => {
            match send_telegram_album(
                &client,
                tok,
                cid,
                &caption,
                &stamp_str,
                &shots,
                notify.telegram_channel_username.as_deref(),
            )
            .await
            {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!("telegram channel album: {e}");
                    HashMap::new()
                }
            }
        }
        _ => HashMap::new(),
    };

    // 4. Persist. One row per size, sharing batch_id. `discord_url` = direct
    //    PNG on cdn.discordapp.com (what the front-end <img> consumes);
    //    `telegram_url` = the public channel post link.
    let batch_id = Uuid::new_v4();
    for s in &shots {
        let key = s.size.as_str();
        let d = discord_cdn.get(key).cloned().unwrap_or_default();
        let tg = tg_channel.get(key).cloned().unwrap_or_default();

        let _ = sqlx::query(
            r#"INSERT INTO wall_snapshots
                    (size, bytes, width, height, discord_url, telegram_url, batch_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        )
        .bind(key)
        .bind(s.png.len() as i64)
        .bind(s.w as i32)
        .bind(s.h as i32)
        .bind(opt_str(&d))
        .bind(opt_str(&tg))
        .bind(batch_id)
        .execute(pool)
        .await;
    }
    Ok(())
}

struct BuiltShot {
    size: Size,
    png: Vec<u8>,
    webp: Option<Vec<u8>>,
    w: u32,
    h: u32,
}
fn opt_str(s: &str) -> Option<&str> {
    if s.is_empty() { None } else { Some(s) }
}

// ---- canvas stitching -----------------------------------------------------

async fn fetch_image(client: &reqwest::Client, url: &str) -> Result<image::DynamicImage, String> {
    let r = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("status {}", r.status()));
    }
    let b = r.bytes().await.map_err(|e| e.to_string())?;
    image::load_from_memory(&b).map_err(|e| e.to_string())
}

async fn build_snapshot(
    client: &reqwest::Client,
    tile_base: &str,
    wall_w: u32,
    wall_h: u32,
    size: Size,
    brick: Option<&image::DynamicImage>,
) -> Result<(Vec<u8>, Option<Vec<u8>>, u32, u32), String> {
    let layer = size.layer();
    let div = 1u32 << layer;
    let w = (wall_w + div - 1) / div;
    let h = (wall_h + div - 1) / div;
    let cols = (w + TILE - 1) / TILE;
    let rows = (h + TILE - 1) / TILE;
    let stage_w = cols * TILE;
    let stage_h = rows * TILE;

    // 1. Build the brick layer first so empty/missing tiles show the texture.
    //    Resize the brick image by 1/div so the pattern is consistent across
    //    quality levels (small wall ⇒ small bricks).
    let mut stage = if let Some(b) = brick {
        let scaled = if div > 1 {
            b.resize(
                (b.width() / div).max(1),
                (b.height() / div).max(1),
                image::imageops::FilterType::Lanczos3,
            )
        } else {
            b.clone()
        };
        tile_pattern(stage_w, stage_h, &scaled.to_rgba8())
    } else {
        image::RgbaImage::from_pixel(stage_w, stage_h, image::Rgba([60, 40, 32, 255]))
    };

    // 2. Fan out tile fetches. Grid starts at top-left = (0,0); the tile at
    //    (tx, ty) draws onto stage at pixel (tx * TILE, ty * TILE).
    let bust = chrono::Utc::now().timestamp();
    let mut handles: Vec<(
        u32,
        u32,
        tokio::task::JoinHandle<Option<image::DynamicImage>>,
    )> = Vec::with_capacity((cols * rows) as usize);
    for ty in 0..rows {
        for tx in 0..cols {
            let url = format!("{tile_base}/tiles/{layer}/{tx}/{ty}.png?v={bust}");
            let c = client.clone();
            handles.push((
                tx,
                ty,
                tokio::spawn(async move {
                    let r = c.get(&url).send().await.ok()?;
                    if !r.status().is_success() {
                        return None;
                    }
                    let b = r.bytes().await.ok()?;
                    image::load_from_memory(&b).ok()
                }),
            ));
        }
    }
    for (tx, ty, hh) in handles {
        let Ok(Some(tile)) = hh.await else {
            continue;
        };
        let tile = tile.to_rgba8();
        image::imageops::overlay(&mut stage, &tile, (tx * TILE) as i64, (ty * TILE) as i64);
    }
    let cropped = image::imageops::crop_imm(&stage, 0, 0, w, h).to_image();

    // Add a Win95-styled title bar above the wall. The bar lives outside
    // the wall rectangle so it doesn't paint over any pixels — viewers
    // get the full canvas with a banner on top.
    let stamp = chrono::Utc::now().format("%Y-%m-%d %H:%M UTC").to_string();
    let final_img = add_win95_header(&cropped, &stamp);

    // Encode: Large produces BOTH PNG (for Telegram) and WebP (for Discord).
    // Small/Medium → PNG only (already small, no need for WebP).
    use image::ImageEncoder;
    let mut png_buf: Vec<u8> = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png_buf)
        .write_image(
            final_img.as_raw(),
            final_img.width(),
            final_img.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("png encode: {e}"))?;

    let webp_buf = match size {
        Size::Large => {
            let encoder =
                webp::Encoder::from_rgba(final_img.as_raw(), final_img.width(), final_img.height());
            let mem = encoder.encode_lossless();
            let mut wb = mem.to_vec();
            if wb.len() > 24 * 1024 * 1024 {
                let enc2 = webp::Encoder::from_rgba(
                    final_img.as_raw(),
                    final_img.width(),
                    final_img.height(),
                );
                wb = enc2.encode(90.0).to_vec();
            }
            Some(wb)
        }
        _ => None,
    };
    Ok((png_buf, webp_buf, final_img.width(), final_img.height()))
}

/// Draw a Win95-style title bar above the wall (does NOT overlay any wall
/// pixels — output canvas grows in height to accommodate the strip).
///
/// Composition (top to bottom):
///   [ 2px outset border highlight     ]   white
///   [ blue gradient title bar w/ text ]   navy → light blue
///   [ 2px outset border shadow        ]   dark grey
///   [ 1px separator                   ]   grey
///   [ original wall image             ]
fn add_win95_header(wall: &image::RgbaImage, timestamp: &str) -> image::RgbaImage {
    // Header height scales with the wall so it looks proportional across
    // small/medium/large. Roomier than before — old version had text almost
    // touching the top/bottom edges of the bar.
    let header_h: u32 = (wall.height() / 50).clamp(44, 160);

    let w = wall.width();
    let h = wall.height() + header_h;
    let mut out = image::RgbaImage::new(w, h);

    // 1. Gradient navy → light blue across the title bar.
    for y in 0..header_h {
        // Cap top and bottom rows for the raised border.
        let is_top_border = y < 2;
        let is_bot_border = y >= header_h - 2;
        let row_color = if is_top_border {
            image::Rgba([255, 255, 255, 255])
        } else if is_bot_border {
            image::Rgba([64, 64, 64, 255])
        } else {
            // Horizontal gradient: x=0 → navy, x=W → light azure.
            let t = (y as f32) / (header_h as f32);
            // Lerp navy → cyan-ish for a Win95 active title bar feel.
            let r = (0.0 + 16.0 * t) as u8;
            let g = (0.0 + 132.0 * t) as u8;
            let b = (128.0 + 80.0 * t) as u8;
            image::Rgba([r, g, b, 255])
        };
        for x in 0..w {
            out.put_pixel(x, y, row_color);
        }
    }
    // Vertical raised border highlight on left, shadow on right.
    for y in 1..header_h - 1 {
        out.put_pixel(0, y, image::Rgba([255, 255, 255, 255]));
        out.put_pixel(w - 1, y, image::Rgba([64, 64, 64, 255]));
    }

    // 2. Text. We draw a simple 5x7 bitmap font; the message stretches by
    //    `scale` so the text height roughly matches the bar height.
    let msg = format!("Generated with The Wall Dev | At: {timestamp} | the-wall.vai-rice.space");
    // Text occupies ~50% of the bar height, leaving generous vertical padding.
    let scale: u32 = (header_h / 14).max(2);
    let glyph_w = 5 * scale; // includes 1 pixel of inter-letter spacing implicitly
    let advance = 6 * scale;
    let text_w = (msg.chars().count() as u32) * advance;
    let text_h = 7 * scale;

    // Centre horizontally; if the text would overflow, shrink scale.
    let (scale, advance, text_w) = if text_w > w.saturating_sub(8) && w > 8 {
        let s = (w.saturating_sub(8) / (msg.chars().count() as u32 * 6)).max(1);
        (s, 6 * s, msg.chars().count() as u32 * 6 * s)
    } else {
        (scale, advance, text_w)
    };
    let _ = glyph_w;
    let x0: i32 = ((w as i32) - (text_w as i32)) / 2;
    let y0: i32 = ((header_h as i32) - (7 * scale as i32)) / 2;
    let _ = text_h;

    let text_color = image::Rgba([255, 255, 255, 255]);
    let shadow = image::Rgba([0, 0, 0, 160]);
    for (i, ch) in msg.chars().enumerate() {
        let g = glyph_for(ch);
        let cx = x0 + (i as i32) * (advance as i32);
        for (row, bits) in g.iter().enumerate() {
            for col in 0..5 {
                if (bits >> (4 - col)) & 1 == 1 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let px = cx + (col * scale as i32) + dx as i32;
                            let py = y0 + (row as i32 * scale as i32) + dy as i32;
                            if px < 0 || py < 0 || px >= w as i32 || py >= header_h as i32 {
                                continue;
                            }
                            // 1px text shadow below-right for legibility
                            if px + 1 < w as i32 && py + 1 < header_h as i32 {
                                blend(&mut out, (px + 1) as u32, (py + 1) as u32, shadow);
                            }
                            out.put_pixel(px as u32, py as u32, text_color);
                        }
                    }
                }
            }
        }
    }

    // 3. 1px thin separator between header and wall.
    for x in 0..w {
        out.put_pixel(x, header_h - 1, image::Rgba([32, 32, 32, 255]));
    }

    // 4. Paste the wall starting at y = header_h.
    image::imageops::overlay(&mut out, wall, 0, header_h as i64);
    out
}

fn blend(img: &mut image::RgbaImage, x: u32, y: u32, src: image::Rgba<u8>) {
    if x >= img.width() || y >= img.height() {
        return;
    }
    let dst = img.get_pixel_mut(x, y);
    let a = src[3] as f32 / 255.0;
    for k in 0..3 {
        dst[k] = ((dst[k] as f32) * (1.0 - a) + (src[k] as f32) * a) as u8;
    }
}

/// 5×7 bitmap glyphs for a printable-ASCII subset (digits, A-Z, a-z, common
/// punctuation we use). Each entry: 7 rows, leftmost pixel = bit 4.
/// Unknown chars fall through to '?'.
fn glyph_for(c: char) -> [u8; 7] {
    match c {
        ' ' => [0, 0, 0, 0, 0, 0, 0],
        '!' => [4, 4, 4, 4, 0, 4, 0],
        '|' => [4, 4, 4, 4, 4, 4, 4],
        '/' => [1, 1, 2, 4, 8, 16, 16],
        '\\' => [16, 16, 8, 4, 2, 1, 1],
        '.' => [0, 0, 0, 0, 0, 4, 4],
        ',' => [0, 0, 0, 0, 0, 4, 8],
        ':' => [0, 4, 4, 0, 4, 4, 0],
        '-' => [0, 0, 0, 14, 0, 0, 0],
        '_' => [0, 0, 0, 0, 0, 0, 31],
        '@' => [14, 17, 23, 21, 23, 16, 14],
        '(' => [2, 4, 8, 8, 8, 4, 2],
        ')' => [8, 4, 2, 2, 2, 4, 8],
        // digits
        '0' => [14, 17, 19, 21, 25, 17, 14],
        '1' => [4, 12, 4, 4, 4, 4, 14],
        '2' => [14, 17, 1, 2, 4, 8, 31],
        '3' => [14, 17, 1, 6, 1, 17, 14],
        '4' => [2, 6, 10, 18, 31, 2, 2],
        '5' => [31, 16, 30, 1, 1, 17, 14],
        '6' => [6, 8, 16, 30, 17, 17, 14],
        '7' => [31, 1, 2, 4, 8, 8, 8],
        '8' => [14, 17, 17, 14, 17, 17, 14],
        '9' => [14, 17, 17, 15, 1, 2, 12],
        // upper
        'A' => [14, 17, 17, 31, 17, 17, 17],
        'B' => [30, 17, 17, 30, 17, 17, 30],
        'C' => [14, 17, 16, 16, 16, 17, 14],
        'D' => [30, 17, 17, 17, 17, 17, 30],
        'E' => [31, 16, 16, 30, 16, 16, 31],
        'F' => [31, 16, 16, 30, 16, 16, 16],
        'G' => [14, 17, 16, 23, 17, 17, 14],
        'H' => [17, 17, 17, 31, 17, 17, 17],
        'I' => [14, 4, 4, 4, 4, 4, 14],
        'J' => [7, 2, 2, 2, 2, 18, 12],
        'K' => [17, 18, 20, 24, 20, 18, 17],
        'L' => [16, 16, 16, 16, 16, 16, 31],
        'M' => [17, 27, 21, 21, 17, 17, 17],
        'N' => [17, 17, 25, 21, 19, 17, 17],
        'O' => [14, 17, 17, 17, 17, 17, 14],
        'P' => [30, 17, 17, 30, 16, 16, 16],
        'Q' => [14, 17, 17, 17, 21, 18, 13],
        'R' => [30, 17, 17, 30, 20, 18, 17],
        'S' => [14, 17, 16, 14, 1, 17, 14],
        'T' => [31, 4, 4, 4, 4, 4, 4],
        'U' => [17, 17, 17, 17, 17, 17, 14],
        'V' => [17, 17, 17, 17, 17, 10, 4],
        'W' => [17, 17, 17, 21, 21, 21, 10],
        'X' => [17, 17, 10, 4, 10, 17, 17],
        'Y' => [17, 17, 17, 10, 4, 4, 4],
        'Z' => [31, 1, 2, 4, 8, 16, 31],
        // lower (we approximate by uppercase scaled)
        'a' => [0, 14, 1, 15, 17, 17, 15],
        'b' => [16, 16, 30, 17, 17, 17, 30],
        'c' => [0, 14, 16, 16, 16, 17, 14],
        'd' => [1, 1, 15, 17, 17, 17, 15],
        'e' => [0, 14, 17, 31, 16, 17, 14],
        'f' => [6, 9, 8, 28, 8, 8, 8],
        'g' => [0, 15, 17, 17, 15, 1, 14],
        'h' => [16, 16, 30, 17, 17, 17, 17],
        'i' => [4, 0, 12, 4, 4, 4, 14],
        'j' => [2, 0, 6, 2, 2, 18, 12],
        'k' => [16, 16, 18, 20, 24, 20, 18],
        'l' => [12, 4, 4, 4, 4, 4, 14],
        'm' => [0, 26, 21, 21, 17, 17, 17],
        'n' => [0, 22, 25, 17, 17, 17, 17],
        'o' => [0, 14, 17, 17, 17, 17, 14],
        'p' => [0, 30, 17, 17, 30, 16, 16],
        'q' => [0, 15, 17, 17, 15, 1, 1],
        'r' => [0, 22, 25, 16, 16, 16, 16],
        's' => [0, 15, 16, 14, 1, 17, 30],
        't' => [8, 8, 28, 8, 8, 9, 6],
        'u' => [0, 17, 17, 17, 17, 17, 15],
        'v' => [0, 17, 17, 17, 17, 10, 4],
        'w' => [0, 17, 17, 21, 21, 21, 10],
        'x' => [0, 17, 10, 4, 10, 17, 17],
        'y' => [0, 17, 17, 15, 1, 2, 12],
        'z' => [0, 31, 2, 4, 8, 16, 31],
        _ => [14, 17, 1, 2, 4, 0, 4], // '?'
    }
}

fn tile_pattern(w: u32, h: u32, brick: &image::RgbaImage) -> image::RgbaImage {
    let mut img = image::RgbaImage::new(w, h);
    let bw = brick.width().max(1);
    let bh = brick.height().max(1);
    let mut y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            image::imageops::overlay(&mut img, brick, x as i64, y as i64);
            x = x.saturating_add(bw);
        }
        y = y.saturating_add(bh);
    }
    img
}

// ---- delivery -------------------------------------------------------------

/// Discord delivery split across 4 messages so we never hit the per-message
/// upload cap (8 MB for free bots): one metadata text message followed by
/// one image-per-message (Small → Medium → Large). Returns a per-size map
/// of the direct CDN URLs from each image message's response.
async fn send_discord_album(
    client: &reqwest::Client,
    bot_token: &str,
    user_id: &str,
    caption: &str,
    stamp: &str,
    shots: &[BuiltShot],
) -> Result<HashMap<&'static str, String>, String> {
    // 1. Open the DM channel once; reuse for all four messages.
    let ch_resp = client
        .post("https://discord.com/api/v10/users/@me/channels")
        .header("Authorization", format!("Bot {bot_token}"))
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"recipient_id":"{user_id}"}}"#))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !ch_resp.status().is_success() {
        return Err(format!("open channel: {}", ch_resp.status()));
    }
    #[derive(serde::Deserialize)]
    struct Ch {
        id: String,
    }
    let ch: Ch = ch_resp.json().await.map_err(|e| e.to_string())?;

    // 2. Metadata message: timestamp + sizes + bytes. Plain text only.
    let _ = client
        .post(format!(
            "https://discord.com/api/v10/channels/{}/messages",
            ch.id
        ))
        .header("Authorization", format!("Bot {bot_token}"))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "content": caption }).to_string())
        .send()
        .await
        .map_err(|e| format!("send metadata: {e}"))?;

    // 3. One image per message. Discord caps free-bot uploads at 8 MB, so
    //    bundling all three in one DM was hitting 413. Per-message parsing
    //    of `attachments[0].url` gives us the direct CDN URL we persist.
    #[derive(serde::Deserialize)]
    struct Att {
        url: String,
    }
    #[derive(serde::Deserialize)]
    struct Msg {
        attachments: Vec<Att>,
    }

    let mut out: HashMap<&'static str, String> = HashMap::new();
    for s in shots {
        // Discord gets WebP for Large (smaller), PNG for Small/Medium.
        let (bytes, filename, mime) = if let Some(ref wb) = s.webp {
            (
                wb.clone(),
                format!("wall_{stamp}_{size}.webp", size = s.size.as_str()),
                "image/webp",
            )
        } else {
            (
                s.png.clone(),
                format!("wall_{stamp}_{size}.png", size = s.size.as_str()),
                "image/png",
            )
        };
        let payload = serde_json::json!({
            "content": format!("{} · {}×{} ({})",
                s.size.label_full(), s.w, s.h, fmt_bytes(bytes.len())),
            "attachments": [{
                "id": 0,
                "filename": filename,
                "description": format!("{} snapshot", s.size.label()),
            }],
        });
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(filename.clone())
            .mime_str(mime)
            .map_err(|e| e.to_string())?;
        let form = reqwest::multipart::Form::new()
            .text("payload_json", payload.to_string())
            .part("files[0]", part);

        let r = client
            .post(format!(
                "https://discord.com/api/v10/channels/{}/messages",
                ch.id
            ))
            .header("Authorization", format!("Bot {bot_token}"))
            .multipart(form)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            tracing::warn!("discord {}: status {}", s.size.as_str(), r.status());
            continue;
        }
        let m: Msg = r.json().await.map_err(|e| e.to_string())?;
        if let Some(att) = m.attachments.first() {
            out.insert(s.size.as_str(), att.url.clone());
        }
    }
    Ok(out)
}

/// Telegram media group via `sendMediaGroup`. Returns a per-size map of the
/// t.me/<channel>/<msg_id> URL when `channel_username` is provided (used for
/// channel posts). Empty map for DMs.
async fn send_telegram_album(
    client: &reqwest::Client,
    bot_token: &str,
    chat_id: &str,
    caption: &str,
    stamp: &str,
    shots: &[BuiltShot],
    channel_username: Option<&str>,
) -> Result<HashMap<&'static str, String>, String> {
    // Build the JSON media spec; each entry references a multipart field
    // by name through the `attach://name` URI. Caption rides on the LAST file
    // (Large — shots are pre-sorted Small→Medium→Large) so it appears under
    // the headline image in the Telegram client.
    //
    // Telegram gets ALL sizes as PNG documents. If Large was encoded as WebP
    // (for Discord), we re-encode it to PNG here. This avoids Telegram's
    // "Wrong file identifier" errors with WebP + sendMediaGroup documents.
    let last = shots.len().saturating_sub(1);
    let mut media_json = Vec::new();
    for (i, _s) in shots.iter().enumerate() {
        let field = format!("file{i}");
        let mut entry = serde_json::json!({
            "type": "document",
            "media": format!("attach://{field}"),
        });
        if i == last {
            entry["caption"] = serde_json::Value::String(caption.to_string());
        }
        media_json.push(entry);
    }

    let mut form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.to_string())
        .text("media", serde_json::to_string(&media_json).unwrap());

    for (i, s) in shots.iter().enumerate() {
        // Telegram always gets PNG — the `png` field is always PNG-encoded.
        let fname = format!("wall_{stamp}_{size}.png", size = s.size.as_str());
        tracing::debug!("telegram file{i}: name={fname} bytes={}", s.png.len());
        let part = reqwest::multipart::Part::bytes(s.png.clone())
            .file_name(fname)
            .mime_str("image/png")
            .map_err(|e| e.to_string())?;
        form = form.part(format!("file{i}"), part);
    }

    let r = client
        .post(format!(
            "https://api.telegram.org/bot{bot_token}/sendMediaGroup"
        ))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = r.status();
    let body: serde_json::Value = r
        .json()
        .await
        .map_err(|e| format!("decode {status}: {e}"))?;
    if !body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let desc = body
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("tg error");
        tracing::warn!(
            "telegram sendMediaGroup failed: chat_id={chat_id} description={desc} full_response={}",
            serde_json::to_string(&body).unwrap_or_default(),
        );
        return Err(desc.to_string());
    }

    // Telegram returns the result as an array of Message objects in the same
    // order we sent them. We extract message_id per entry → t.me URL.
    // For DMs (no channel_username) we drop the result entirely — those are
    // notifications, not persisted.
    let arr = body
        .get("result")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: HashMap<&'static str, String> = HashMap::new();
    if let Some(u) = channel_username.filter(|s| !s.is_empty()) {
        let u = u.trim_start_matches('@');
        for (i, s) in shots.iter().enumerate() {
            if let Some(id) = arr
                .get(i)
                .and_then(|m| m.get("message_id"))
                .and_then(|v| v.as_i64())
            {
                out.insert(s.size.as_str(), format!("https://t.me/{u}/{id}"));
            }
        }
    }
    Ok(out)
}
