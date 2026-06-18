//! Build script — runs at `cargo build` time.
//!
//! Bakes the build timestamp into the binary via a rustc env-var so that
//! `option_env!("BUILD_TIMESTAMP")` in main code resolves to the moment the
//! crate was compiled. Format: ISO-8601 UTC, second precision (e.g.
//! `2026-06-03T20:14:33Z`).
//!
//! The marker is regenerated on every release build because we tell cargo to
//! rerun whenever any source file changes. On incremental dev builds where
//! nothing changed, cargo skips the script and the previously baked-in value
//! sticks — that's fine, it still reflects the last actual compile.

use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // Rerun when anything that affects the binary changes.
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=migrations");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=Cargo.lock");

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // Tiny inline UTC formatter — pulling chrono into the build script just
    // for this would be overkill.
    let ts = format_iso_utc(now);
    println!("cargo:rustc-env=BUILD_TIMESTAMP={ts}");
}

/// Format `secs_since_epoch` as ISO-8601 UTC with second precision.
///
/// Standard Gregorian arithmetic via days-from-epoch (1970-01-01 was a
/// Thursday). Good enough through year 9999.
fn format_iso_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400) as u32;
    let h = time_of_day / 3600;
    let m = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;

    // Convert days since 1970-01-01 to civil (Y, M, D) using Howard Hinnant's
    // formula from the libc++ chrono implementation. Works for any signed day.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if mo <= 2 { y + 1 } else { y };

    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, m, s)
}
