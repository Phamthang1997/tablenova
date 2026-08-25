//! Credentials: where they come from and where they are kept.
//!
//! These three files share NO code — they share a concern. Grouping them gives the question
//! "where does the app keep its secrets, and how does it obtain them" exactly one place to be answered.

pub mod aws_iam;
pub mod oauth;
pub mod secret_store;
