//! Config-contract tests — run offline, no server or database needed.
//!
//! The backend keeps a `KNOWN_ENV_KEYS` whitelist in `src/main.rs` that the
//! boot-time typo detector checks env files against. These tests pin the
//! contract from the other side: every key documented in `example.env` must
//! be in the whitelist, so docs and detector can't silently drift apart.
//!
//! Run: `cargo test --manifest-path backend/Cargo.toml --test env_contract`

use std::collections::HashSet;
use std::fs;
use std::path::Path;

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

/// Extract the quoted strings of the `KNOWN_ENV_KEYS` array from main.rs.
fn known_env_keys() -> Vec<String> {
    let src = fs::read_to_string(manifest_dir().join("src/main.rs"))
        .expect("read backend/src/main.rs");
    let start = src
        .find("const KNOWN_ENV_KEYS")
        .expect("KNOWN_ENV_KEYS not found in main.rs");
    let tail = &src[start..];
    let end = tail.find("];").expect("KNOWN_ENV_KEYS array not terminated");
    let body = &tail[..end];
    let mut keys = Vec::new();
    let mut rest = body;
    while let Some(open) = rest.find('"') {
        let after = &rest[open + 1..];
        let close = after.find('"').expect("unterminated string in KNOWN_ENV_KEYS");
        keys.push(after[..close].to_string());
        rest = &after[close + 1..];
    }
    assert!(
        keys.len() >= 20,
        "suspiciously few KNOWN_ENV_KEYS extracted: {}",
        keys.len()
    );
    keys
}

/// Keys mentioned in an env file: `KEY=...` lines plus commented `#KEY=...`
/// examples (those document real keys too).
fn env_file_keys(path: &Path) -> Vec<String> {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    let mut keys = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let candidate = line.strip_prefix('#').unwrap_or(line).trim();
        if let Some(eq) = candidate.find('=') {
            let key = &candidate[..eq];
            if !key.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            {
                keys.push(key.to_string());
            }
        }
    }
    keys
}

#[test]
fn example_env_keys_are_all_known() {
    let known: HashSet<String> = known_env_keys().into_iter().collect();
    let unknown: Vec<String> = env_file_keys(&manifest_dir().join("example.env"))
        .into_iter()
        .filter(|k| !known.contains(k))
        .collect();
    assert!(
        unknown.is_empty(),
        "example.env documents keys missing from KNOWN_ENV_KEYS in main.rs: {unknown:?}"
    );
}

#[test]
fn known_env_keys_have_no_duplicates() {
    let keys = known_env_keys();
    let mut seen = HashSet::new();
    let dupes: Vec<&String> = keys.iter().filter(|k| !seen.insert(k.as_str())).collect();
    assert!(dupes.is_empty(), "duplicate KNOWN_ENV_KEYS entries: {dupes:?}");
}
