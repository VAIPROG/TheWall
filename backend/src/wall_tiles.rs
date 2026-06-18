//! Shared wall-tile fetching.
//!
//! Composes a native-resolution (layer-0) window of the wall by fetching the
//! 256px tiles that cover it — the same source of truth the snapshot worker
//! and the extension's progress counter use. Extracted from the retired
//! anti-grief template monitor; the region guard is the main consumer now.

use std::collections::HashMap;
use std::sync::Arc;

/// Hard cap on tile fetches per window, so one oversized request can't
/// hammer the tile server.
const MAX_TILES_PER_CHECK: usize = 64;

const TILE: u32 = 256;

/// Fetch a (w × h) window starting at (x, y) on the wall by composing tile
/// images. Uses layer 0 (native resolution). Shared with region_guard.
pub(crate) async fn fetch_wall_window(
    tile_base: &str,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<image::DynamicImage, String> {
    let x0 = x / TILE;
    let y0 = y / TILE;
    let x1 = (x + w + TILE - 1) / TILE;
    let y1 = (y + h + TILE - 1) / TILE;
    let cols = x1 - x0;
    let rows = y1 - y0;
    if (cols * rows) as usize > MAX_TILES_PER_CHECK {
        return Err(format!("window {cols}x{rows} exceeds cap"));
    }

    let client = Arc::new(reqwest::Client::new());
    let mut handles: HashMap<(u32, u32), tokio::task::JoinHandle<Option<image::DynamicImage>>> =
        HashMap::new();
    for ty in y0..y1 {
        for tx in x0..x1 {
            let client = client.clone();
            let url = format!(
                "{tile_base}/tiles/0/{tx}/{ty}.png?v={}",
                chrono::Utc::now().timestamp()
            );
            handles.insert(
                (tx, ty),
                tokio::spawn(async move {
                    let r = client.get(&url).send().await.ok()?;
                    if !r.status().is_success() {
                        return None;
                    }
                    let bytes = r.bytes().await.ok()?;
                    image::load_from_memory(&bytes).ok()
                }),
            );
        }
    }

    let mut stage =
        image::RgbaImage::from_pixel(cols * TILE, rows * TILE, image::Rgba([0, 0, 0, 0]));
    for ((tx, ty), h) in handles {
        let Ok(Some(tile)) = h.await else {
            continue;
        };
        let tile = tile.to_rgba8();
        let dx = (tx - x0) * TILE;
        let dy = (ty - y0) * TILE;
        image::imageops::overlay(&mut stage, &tile, dx as i64, dy as i64);
    }

    // Crop to the exact requested window.
    let crop_x = x - x0 * TILE;
    let crop_y = y - y0 * TILE;
    let cropped = image::imageops::crop_imm(&stage, crop_x, crop_y, w, h).to_image();
    Ok(image::DynamicImage::ImageRgba8(cropped))
}
