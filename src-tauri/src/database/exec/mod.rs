//! The three SQL execution funnels. The same function body runs whether the connection came from the pool
//! or from a pinned transaction session — see `tx.rs`.

pub mod bound;
pub mod raw;
pub mod stream;
