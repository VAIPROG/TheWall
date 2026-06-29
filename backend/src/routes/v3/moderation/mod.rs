//! V3 moderation routes — restrictions CRUD, report queue, template approval
//! queue, and the moderation audit log.

mod audit_log;
mod queue;
mod reports;
mod restrictions;

pub use audit_log::get_audit_log;
pub use queue::{approve_template, get_queue, reject_template};
pub use reports::{dismiss_report, get_report, list_reports, resolve_report, update_report};
pub use restrictions::{
    create_restriction, delete_restriction, get_restriction, list_restrictions,
    update_restriction, user_restrictions,
};
