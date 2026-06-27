//! V3 template CRUD — canonical the-wall-dev/2 document format.

mod create;
mod delete;
mod read;

pub use create::create;
pub use delete::delete;
pub use read::{get, list};
