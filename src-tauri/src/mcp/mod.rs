//! The built-in MCP server: an AI client on this machine reads databases through the connections the
//! user already has open, instead of being handed a connection string of its own.
//!
//! Plan, and the reasoning behind every decision here: `docs/mcp-server-plan.md`.
//!
//! **The protocol is not implemented in this directory.** `rmcp` (the official SDK, pinned at 3.1)
//! owns JSON-RPC 2.0, `initialize`, version negotiation and Streamable HTTP sessions. Writing a
//! hand-rolled parser here is the sign of a wrong turn: the spec revision moved twice while the plan
//! was being written, and version negotiation is exactly the part that fails silently once it is
//! stale. `rmcp` 3.1 implements revision **2026-07-28** and stays compatible back to 2025-11-25.
//!
//! What this directory owns is everything `rmcp` deliberately does not: where the server binds, who
//! is allowed to talk to it, which connections it may see, and what it is allowed to run.
//!
//! Five defence layers, in the order a request meets them (§3 of the plan):
//!
//! 1. **Bind `127.0.0.1` + `Origin`/`Host` validation** (`http.rs`). Loopback alone is not a wall: a
//!    page in the user's own browser can reach a loopback port, and DNS rebinding forges `Host`.
//!    The header check is what stops both.
//! 2. **Bearer token** from the OS keyring (`auth.rs`).
//! 3. **Per-connection exposure, default OFF** — `policy.rs`, not built yet (Bước 2).
//! 4. **`read_only` + a read-only statement filter** — `policy.rs`, not built yet (Bước 2).
//! 5. **Interactive approval** — V2, not built.
//!
//! Layers 3-5 do not exist yet, and that is precisely why `tools/` exposes nothing that touches a
//! database. The transport is real; the surface is empty on purpose until the layers guarding it are
//! in place.

mod audit;
mod auth;
mod http;
mod policy;
mod server;
mod tools;

pub mod commands;

pub use server::{DEFAULT_PORT, McpServer, McpStatus};
