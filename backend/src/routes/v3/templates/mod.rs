//! V3 template CRUD — canonical the-wall-dev/2 document format.

pub(crate) mod acl;
mod access;
mod backfill;
mod create;
mod delete;
mod export;
pub mod patch_apply;
mod pin;
mod read;
pub(crate) mod render;
mod report;
mod update;
mod verify;

pub use backfill::backfill;
pub use create::create;
pub use delete::delete;
pub use export::{charity, wall_dev};
pub use render::{get_animated, get_png, get_preview};
pub use pin::{list_pinned, pin, unpin};
pub use read::{get, list};
pub use report::report_template;
pub use update::update;
pub use verify::verify;
