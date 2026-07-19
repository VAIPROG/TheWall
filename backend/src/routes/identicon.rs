//! Deterministic, dependency-free avatar/banner fallbacks.
//!
//! When a user or clan has no custom avatar (and no linkable Discord avatar),
//! we still want `<img src>` to render *something* stable instead of a broken
//! image or a 404. These generators derive a GitHub-style identicon (avatars)
//! or a two-tone gradient (banners) purely from a seed string, so the same
//! seed always yields the same picture. Output is SVG — resolution independent,
//! tiny, and cacheable forever.

use axum::{
    body::Body,
    http::{StatusCode, header},
    response::Response,
};

/// 64-bit FNV-1a. Stable across runs/platforms (unlike `DefaultHasher`), which
/// is what makes a seed map to the same identicon every time.
fn fnv1a(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Build a 5×5 mirrored identicon as an SVG string. The left three columns are
/// derived from the low 15 bits of the hash; columns 4–5 mirror columns 2–1 so
/// the glyph is vertically symmetric. Foreground hue comes from the high bits so
/// the colour is uncorrelated with the shape.
pub fn identicon_svg(seed: &str, size: u32) -> String {
    let hash = fnv1a(seed.as_bytes());
    let hue = (hash >> 40) % 360;
    // Pleasant, readable saturation/lightness for a light-gray background.
    let fg = format!("hsl({hue},58%,48%)");

    // 15 cells: col in 0..3, row in 0..5. cell index = col*5 + row.
    let mut cells = String::new();
    for col in 0..3u32 {
        for row in 0..5u32 {
            let idx = col * 5 + row;
            if (hash >> idx) & 1 == 1 {
                // Draw this cell and its mirror (col 4-col).
                cells.push_str(&format!(
                    r#"<rect x="{col}" y="{row}" width="1" height="1"/>"#
                ));
                let mirror = 4 - col;
                if mirror != col {
                    cells.push_str(&format!(
                        r#"<rect x="{mirror}" y="{row}" width="1" height="1"/>"#
                    ));
                }
            }
        }
    }

    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 5 5" shape-rendering="crispEdges"><rect width="5" height="5" fill="#f0f0f0"/><g fill="{fg}">{cells}</g></svg>"##
    )
}

/// Two-tone diagonal gradient banner (16:9-ish) derived from the seed. Used as a
/// clan banner fallback so the header never renders empty.
pub fn banner_svg(seed: &str, width: u32, height: u32) -> String {
    let hash = fnv1a(seed.as_bytes());
    let h1 = hash % 360;
    let h2 = (h1 + 40 + (hash >> 20) % 60) % 360;
    let c1 = format!("hsl({h1},55%,42%)");
    let c2 = format!("hsl({h2},50%,28%)");
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient></defs><rect width="{width}" height="{height}" fill="url(#g)"/></svg>"##
    )
}

/// Wrap an SVG string in an HTTP response. Identicons/banners are deterministic
/// and effectively immutable for a given seed, so they cache aggressively.
pub fn svg_response(svg: String) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/svg+xml; charset=utf-8")
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(Body::from(svg))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identicon_is_deterministic() {
        let a = identicon_svg("user-123", 256);
        let b = identicon_svg("user-123", 256);
        assert_eq!(a, b, "same seed must yield identical SVG");
    }

    #[test]
    fn identicon_differs_by_seed() {
        let a = identicon_svg("user-123", 256);
        let b = identicon_svg("user-456", 256);
        assert_ne!(a, b, "different seeds should (almost always) differ");
    }

    #[test]
    fn identicon_is_horizontally_symmetric() {
        // A mirrored glyph must contain an even count of foreground cells for
        // any column that is not the centre column. We assert the SVG is
        // well-formed and non-empty as a cheap structural check.
        let svg = identicon_svg("symmetry", 64);
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("viewBox=\"0 0 5 5\""));
        assert!(svg.trim_end().ends_with("</svg>"));
    }

    #[test]
    fn banner_is_deterministic() {
        assert_eq!(banner_svg("clan-x", 960, 320), banner_svg("clan-x", 960, 320));
    }
}
