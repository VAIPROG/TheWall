//! V3 chat endpoints — resolve, access control, message CRUD, DM get-or-create,
//! modmail, message reactions, read-state, chat detail, message reports, and pins.

pub mod detail;
pub mod dm;
pub mod list;
pub mod messages;
pub mod modmail;
pub mod pin;
pub mod reactions;
pub mod read;
pub mod report;
pub mod resolve;

pub use detail::get_chat_detail;
pub use dm::{get_dm_thread, send_dm};
pub use list::list_chats;
pub use messages::{delete_message, edit_message, list_messages, send_message};
pub use modmail::{get_modmail, send_modmail};
pub use pin::{pin_message, unpin_message};
pub use reactions::{add_reaction, remove_reaction};
pub use read::mark_read;
pub use report::report_message;
pub use resolve::clan_chat_id;
