//! Data helpers used by commands. Bodies live in `crate::bot_core` until Task 7
//! folds them here; re-exported now so the framework can call a stable path.
pub use crate::bot_core::{
    is_bot_admin, find_user_by_platform, status_data, user_count_data,
    latest_snapshot, recent_events, regions_overview, region_state_label,
    me_data, clan_recent_messages, clan_send_message,
};
