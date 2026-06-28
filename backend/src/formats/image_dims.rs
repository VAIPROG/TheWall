/// Decode a `data:<mime>;base64,<payload>` URI and return the image dimensions
/// `(width, height)` via the `image` crate. Returns `None` on any parse or
/// decode failure so callers can emit warnings rather than hard errors.
use base64::{Engine as _, engine::general_purpose};

pub fn data_url_dims(data_url: &str) -> Option<(u32, u32)> {
    // Split at the comma separating the header from the payload.
    let (_header, payload) = data_url.split_once(',')?;

    // Try standard base64 first, then URL-safe.
    let bytes = general_purpose::STANDARD
        .decode(payload)
        .or_else(|_| general_purpose::URL_SAFE.decode(payload))
        .ok()?;

    let img = image::load_from_memory(&bytes).ok()?;
    Some((img.width(), img.height()))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal 1×1 grayscale PNG — 67 bytes, correct CRC (generated with Node zlib).
    const PNG_1X1: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR42mNoAAAAggCB2kUIOwAAAABJRU5ErkJggg==";

    #[test]
    fn dims_1x1_png() {
        let dims = data_url_dims(PNG_1X1);
        assert_eq!(dims, Some((1, 1)));
    }

    #[test]
    fn dims_bad_data_returns_none() {
        assert_eq!(data_url_dims("data:image/png;base64,not_valid!!!"), None);
    }

    #[test]
    fn dims_missing_comma_returns_none() {
        assert_eq!(data_url_dims("data:image/png;base64"), None);
    }
}
