//! V3 template CRUD — canonical the-wall-dev/2 document format.

mod backfill;
mod create;
mod delete;
mod export;
mod read;
mod verify;

pub use backfill::backfill;
pub use create::create;
pub use delete::delete;
pub use export::{charity, wall_dev};
pub use read::{get, list};
pub use verify::verify;
