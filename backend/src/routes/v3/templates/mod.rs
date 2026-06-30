//! V3 template CRUD — canonical the-wall-dev/2 document format.

mod backfill;
mod create;
mod delete;
mod export;
pub mod patch_apply;
mod pin;
mod read;
mod render;
mod report;
mod update;
mod verify;

pub use backfill::backfill;
pub use create::create;
pub use delete::delete;
pub use export::{charity, wall_dev};
pub use render::{get_png, get_preview};
pub use pin::{list_pinned, pin, unpin};
pub use read::{get, list};
pub use report::report_template;
pub use update::update;
pub use verify::verify;
