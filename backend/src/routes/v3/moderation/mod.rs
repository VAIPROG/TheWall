//! V3 moderation routes — restrictions CRUD.

mod restrictions;

pub use restrictions::{
    create_restriction, delete_restriction, get_restriction, list_restrictions,
    update_restriction, user_restrictions,
};
