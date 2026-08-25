//! Defence layers 3 and 4: which connection an AI client may touch, and what it may run there.
//!
//! Everything in this file answers "no" by default. A tool that forgets to ask still cannot reach a
//! database, because `resolve()` is the only way to turn a `connection_id` from the wire into a
//! usable connection.

use rmcp::ErrorData as McpError;

use crate::database::{DbConnection, split_sql_statements, strip_leading_comments};
use crate::state::AppState;

/// Rows returned to an AI client when the caller does not say otherwise.
pub const DEFAULT_ROW_LIMIT: usize = 100;

/// The ceiling a caller cannot argue past.
///
/// An AI asking for a million rows is not malicious, it is just optimistic; the cap is what keeps
/// one hopeful `limit` from turning into a full table decode.
pub const MAX_ROW_LIMIT: usize = 1000;

/// Statement heads that only read.
///
/// A **whitelist**, and the exact set `src/utils/safeMode.ts` uses, so "what counts as a read" has
/// one answer in this codebase rather than two that drift. Everything else is refused - including
/// `WITH`, which can end in INSERT/UPDATE/DELETE on Postgres, and including anything unrecognised.
/// Refusing wrongly costs the AI one sentence of explanation; allowing wrongly costs rows.
const READ_HEADS: [&str; 5] = ["SELECT", "EXPLAIN", "SHOW", "DESCRIBE", "DESC"];

/// A resolved connection: the handle, plus what a tool needs to name a table on it.
pub struct Target {
    pub conn: DbConnection,
    /// Postgres only, and `None` elsewhere - exactly what `qualified()` expects, so a table name
    /// built here lands in the schema the user is actually looking at rather than in `public`.
    pub schema: Option<String>,
    /// The statement time limit the user configured for this SERVER. An AI client inherits it: the
    /// ceiling exists to protect the database, and who typed the query does not change that.
    pub timeout: Option<std::time::Duration>,
}

/// The connection behind a `connection_id` from the wire, if the user shared it.
///
/// An id that is not exposed gets the SAME error as an id that does not exist. That is deliberate:
/// distinguishing them would confirm to a caller that a connection it may not see is nonetheless
/// open, which is a name, a database and a dialect it was never meant to learn.
pub fn resolve(state: &AppState, connection_id: &str) -> Result<Target, McpError> {
    if !state.connections.is_mcp_exposed(connection_id) {
        return Err(unknown_connection());
    }
    let ctx = state.connections.acquire(connection_id).map_err(|_| unknown_connection())?;
    reject_if_manual(connection_id)?;
    Ok(Target {
        conn: ctx.conn().clone(),
        schema: ctx.raw_schema().map(str::to_owned),
        timeout: crate::database::stmt_timeout(&ctx.server().config()),
    })
}

/// Refuse while the user has a manual transaction going on this connection.
///
/// This is what makes the pooled funnel in `execute_raw_sql_pooled` a belt next to braces rather
/// than the only guard. `should_route()` answers `true` whenever a session exists in manual mode -
/// before it looks at WHO sent the statement - so an AI read arriving mid-transaction would issue
/// `BEGIN` on the user session and light up a transaction they never opened. Refusing here means the
/// question never reaches routing at all; the pooled funnel then covers the sliver where the user
/// flips to manual mode between this check and the query.
///
/// The same shape `restore_backup` and `generate_data` already use (`reject_if_manual_or_open`),
/// with an English message because the reader here is an AI client.
pub fn reject_if_manual(connection_id: &str) -> Result<(), McpError> {
    if crate::tx::manual_mode(connection_id) || crate::tx::is_open(connection_id) {
        return Err(McpError::invalid_params(
            "this connection is in manual-commit mode in TableNova. Ask the user to commit or roll \
             back and switch back to auto-commit before querying it."
                .to_string(),
            None,
        ));
    }
    Ok(())
}

fn unknown_connection() -> McpError {
    // English, and NOT routed through `backendErrors.ts`: this is read by an AI client, not shown in
    // the TableNova UI. Same rule as the comments `compare/` writes into a generated SQL script.
    McpError::invalid_params(
        "unknown connection_id, or it is not shared with MCP clients. Call tablenova_list_connections \
         to see the connections the user shared."
            .to_string(),
        None,
    )
}

/// Is this SQL a single read statement?
///
/// Two refusals, not one. **Multiple statements** are refused because one tool call is one
/// statement: allowing a batch would mean the classification below has to hold for every statement
/// an AI concatenated, which is attack surface a read-only feature has no reason to carry.
/// **Non-reads** are refused by the whitelist above.
///
/// The splitter is the SQL editor's own, so a `;` inside a string, a comment or a `$$…$$` body does
/// not read as two statements - the difference between refusing a valid query and letting a second
/// one through unnoticed.
pub fn ensure_single_read(sql: &str) -> Result<(), McpError> {
    let statements = split_sql_statements(sql);
    match statements.len() {
        0 => return Err(McpError::invalid_params("no SQL statement found".to_string(), None)),
        1 => {}
        n => {
            return Err(McpError::invalid_params(
                format!("expected exactly one statement, got {n}. Send them one call at a time."),
                None,
            ));
        }
    }

    let head = statement_head(&statements[0]);
    if READ_HEADS.contains(&head.as_str()) {
        Ok(())
    } else {
        Err(McpError::invalid_params(
            format!(
                "this build allows read statements only ({}); got `{}`. \
                 Ask the user to run writes from TableNova itself.",
                READ_HEADS.join(", "),
                if head.is_empty() { "?" } else { &head }
            ),
            None,
        ))
    }
}

/// First keyword of a statement, uppercased, read past leading comments and wrapping parens.
///
/// `(SELECT …) UNION (SELECT …)` is still a read, which is why the parens are skipped rather than
/// treated as an unknown shape.
fn statement_head(statement: &str) -> String {
    let text = strip_leading_comments(statement);
    let word: String = text
        .trim_start_matches(['(', ' ', '\t', '\r', '\n'])
        .chars()
        .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
        .collect();
    word.to_uppercase()
}

/// The row cap a caller actually gets.
pub fn row_limit(requested: Option<usize>) -> usize {
    requested.unwrap_or(DEFAULT_ROW_LIMIT).clamp(1, MAX_ROW_LIMIT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_pass_and_everything_else_does_not() {
        for sql in ["SELECT 1", "select * from t", "EXPLAIN SELECT 1", "SHOW TABLES", "DESC t"] {
            assert!(ensure_single_read(sql).is_ok(), "should allow: {sql}");
        }
        for sql in [
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "DROP TABLE t",
            "TRUNCATE t",
            "CREATE TABLE t (a int)",
            // A CTE can end in a write on Postgres, and nothing here parses far enough to tell.
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "CALL do_something()",
        ] {
            assert!(ensure_single_read(sql).is_err(), "should refuse: {sql}");
        }
    }

    #[test]
    fn a_leading_comment_cannot_disguise_a_write() {
        assert!(ensure_single_read("/* SELECT */ DROP TABLE t").is_err());
        assert!(ensure_single_read("-- SELECT\nDELETE FROM t").is_err());
        // ...and must not make a genuine read look unrecognisable either.
        assert!(ensure_single_read("/* daily report */ SELECT 1").is_ok());
    }

    #[test]
    fn parenthesised_unions_are_still_reads() {
        assert!(ensure_single_read("(SELECT 1) UNION (SELECT 2)").is_ok());
    }

    #[test]
    fn a_second_statement_is_refused_but_a_semicolon_in_a_string_is_not() {
        assert!(ensure_single_read("SELECT 1; DROP TABLE t").is_err());
        assert!(ensure_single_read("SELECT 1;").is_ok(), "one statement with a trailing ;");
        // The splitter's whole job: this is ONE statement, not two.
        assert!(ensure_single_read("SELECT 'a;b' FROM t").is_ok());
    }

    #[test]
    fn row_limit_is_clamped_at_both_ends() {
        assert_eq!(row_limit(None), DEFAULT_ROW_LIMIT);
        assert_eq!(row_limit(Some(10)), 10);
        assert_eq!(row_limit(Some(0)), 1);
        assert_eq!(row_limit(Some(9_000_000)), MAX_ROW_LIMIT);
    }
}
