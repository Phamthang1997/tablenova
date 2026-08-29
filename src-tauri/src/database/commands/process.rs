//! Live Processlist and Query Monitoring Commands for TableNova.
//!
//! Provides real-time visibility into database connections, active running queries,
//! lock waits/deadlock blockers, and allows administrators to safely cancel queries
//! or terminate rogue sessions.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::database::{execute_raw_sql_pooled, rows_of, DbConnection};

/// Single session or connection activity entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessItem {
    /// Session/Process ID (Postgres PID, MySQL Connection ID, SQLite pseudo-id)
    pub id: String,
    /// Authenticated user or role
    pub user: String,
    /// Remote host or IP
    pub host: String,
    /// Active database/schema
    pub db: String,
    /// Command type (Query, Sleep, Execute, backend type)
    pub command: String,
    /// Elapsed query/session execution time in seconds
    pub time_seconds: i64,
    /// Session state (e.g., active, idle, idle in transaction)
    pub state: String,
    /// Executed query text
    pub info: String,
    /// PostgreSQL wait event / lock info
    pub wait_event: Option<String>,
    /// Whether query is currently blocked waiting on another transaction/lock
    pub is_blocked: bool,
    /// Blocker session/PID if detected
    pub blocked_by: Option<String>,
}

/// Aggregated metrics summary for the live monitor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessListSummary {
    /// Database dialect (postgres, mysql, sqlite)
    pub dialect: String,
    /// Total open connections on server
    pub total_connections: usize,
    /// Sessions currently executing active statements
    pub active_queries: usize,
    /// Sessions currently blocked on locks
    pub blocked_queries: usize,
    /// Longest running query in seconds
    pub longest_running_seconds: i64,
    /// List of sessions
    pub processes: Vec<ProcessItem>,
}

/// Result of a kill or cancel operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KillResult {
    pub success: bool,
    pub target_id: String,
    pub action: String,
    pub message: String,
}

/// Helper to safely extract string cell value from json row.
fn extract_str(row: &Value, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// Helper to safely extract integer cell value from json row.
fn extract_i64(row: &Value, key: &str) -> i64 {
    match row.get(key) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

/// Fetch active database processes, connections and lock activity.
///
/// Uses `execute_raw_sql_pooled` to bypass transaction router and avoid
/// creating artificial transactions or interfering with active user workloads.
#[tauri::command]
pub async fn get_process_list(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
) -> Result<ProcessListSummary, String> {
    let (conn, dialect) = {
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), ctx.dialect().to_string())
    };

    match dialect.as_str() {
        "postgres" => fetch_postgres_process_list(&conn).await,
        "mysql" => fetch_mysql_process_list(&conn).await,
        "sqlite" => fetch_sqlite_process_list(&conn).await,
        other => Err(format!("Process monitor is not supported for dialect: {other}")),
    }
}

/// PostgreSQL processlist using `pg_stat_activity` and `pg_blocking_pids`.
async fn fetch_postgres_process_list(conn: &DbConnection) -> Result<ProcessListSummary, String> {
    let sql = r#"
        SELECT
            pid::text AS id,
            COALESCE(usename, '') AS user_name,
            COALESCE(client_addr::text, 'local') AS client_host,
            COALESCE(datname, '') AS db_name,
            COALESCE(backend_type, 'client backend') AS cmd,
            COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - query_start))::bigint, 0) AS duration_sec,
            COALESCE(state, 'unknown') AS state_str,
            COALESCE(query, '') AS query_text,
            COALESCE(wait_event_type || ': ' || wait_event, '') AS wait_info,
            COALESCE(array_to_string(pg_blocking_pids(pid), ','), '') AS blockers
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
        ORDER BY duration_sec DESC, pid ASC;
    "#
    .to_string();

    let raw_res = execute_raw_sql_pooled(conn, sql).await?;
    let rows = rows_of(&raw_res);

    let mut processes = Vec::with_capacity(rows.len());
    let mut active_count = 0;
    let mut blocked_count = 0;
    let mut max_duration: i64 = 0;

    for row in rows {
        let id = extract_str(&row, "id");
        let user = extract_str(&row, "user_name");
        let host = extract_str(&row, "client_host");
        let db = extract_str(&row, "db_name");
        let command = extract_str(&row, "cmd");
        let mut time_seconds = extract_i64(&row, "duration_sec");
        if time_seconds < 0 {
            time_seconds = 0;
        }
        let state = extract_str(&row, "state_str");
        let info = extract_str(&row, "query_text");
        let wait_raw = extract_str(&row, "wait_info");
        let wait_event = if wait_raw.is_empty() { None } else { Some(wait_raw) };
        let blockers = extract_str(&row, "blockers");
        let is_blocked = !blockers.is_empty();
        let blocked_by = if is_blocked { Some(blockers) } else { None };

        let is_active = state.eq_ignore_ascii_case("active");
        if is_active {
            active_count += 1;
            if time_seconds > max_duration {
                max_duration = time_seconds;
            }
        }
        if is_blocked {
            blocked_count += 1;
        }

        processes.push(ProcessItem {
            id,
            user,
            host,
            db,
            command,
            time_seconds,
            state,
            info,
            wait_event,
            is_blocked,
            blocked_by,
        });
    }

    let total = processes.len();
    Ok(ProcessListSummary {
        dialect: "postgres".to_string(),
        total_connections: total,
        active_queries: active_count,
        blocked_queries: blocked_count,
        longest_running_seconds: max_duration,
        processes,
    })
}

/// MySQL processlist using `information_schema.PROCESSLIST`.
async fn fetch_mysql_process_list(conn: &DbConnection) -> Result<ProcessListSummary, String> {
    let sql = r#"
        SELECT
            CAST(ID AS CHAR) AS id,
            COALESCE(USER, '') AS user_name,
            COALESCE(HOST, '') AS client_host,
            COALESCE(DB, '') AS db_name,
            COALESCE(COMMAND, '') AS cmd,
            COALESCE(TIME, 0) AS duration_sec,
            COALESCE(STATE, '') AS state_str,
            COALESCE(INFO, '') AS query_text
        FROM information_schema.PROCESSLIST
        WHERE ID <> CONNECTION_ID()
        ORDER BY duration_sec DESC, id ASC;
    "#
    .to_string();

    let raw_res = execute_raw_sql_pooled(conn, sql).await?;
    let rows = rows_of(&raw_res);

    let mut processes = Vec::with_capacity(rows.len());
    let mut active_count = 0;
    let mut blocked_count = 0;
    let mut max_duration: i64 = 0;

    for row in rows {
        let id = extract_str(&row, "id");
        let user = extract_str(&row, "user_name");
        let host = extract_str(&row, "client_host");
        let db = extract_str(&row, "db_name");
        let command = extract_str(&row, "cmd");
        let time_seconds = extract_i64(&row, "duration_sec");
        let state = extract_str(&row, "state_str");
        let info = extract_str(&row, "query_text");

        let user_lower = user.to_lowercase();
        let cmd_lower = command.to_lowercase();
        let state_lower = state.to_lowercase();

        // Daemons, scheduler threads, and sleeping sessions are not active queries
        let is_daemon = user_lower == "event_scheduler"
            || user_lower == "system user"
            || cmd_lower == "daemon"
            || cmd_lower == "binlog dump"
            || cmd_lower == "connect"
            || state_lower.contains("waiting on empty queue");

        let is_sleep = cmd_lower == "sleep";
        let has_query = !info.trim().is_empty() && info.trim() != "--";
        let is_blocked = state_lower.contains("lock") || state_lower.contains("waiting for table") || state_lower.contains("waiting for lock");
        let is_active = !is_daemon && !is_sleep && (cmd_lower == "query" || cmd_lower == "execute" || has_query);

        if is_active {
            active_count += 1;
            if time_seconds > max_duration {
                max_duration = time_seconds;
            }
        }
        if is_blocked {
            blocked_count += 1;
        }

        let effective_state = if state.is_empty() {
            if is_sleep {
                "Sleep".to_string()
            } else {
                command.clone()
            }
        } else {
            state
        };

        processes.push(ProcessItem {
            id,
            user,
            host,
            db,
            command,
            time_seconds,
            state: effective_state,
            info,
            wait_event: None,
            is_blocked,
            blocked_by: None,
        });
    }

    let total = processes.len();
    Ok(ProcessListSummary {
        dialect: "mysql".to_string(),
        total_connections: total,
        active_queries: active_count,
        blocked_queries: blocked_count,
        longest_running_seconds: max_duration,
        processes,
    })
}

/// SQLite status reporting for embedded database.
async fn fetch_sqlite_process_list(conn: &DbConnection) -> Result<ProcessListSummary, String> {
    let raw_res = execute_raw_sql_pooled(conn, "PRAGMA journal_mode;".to_string()).await?;
    let rows = rows_of(&raw_res);
    let journal_mode = rows
        .first()
        .map(|r| extract_str(r, "journal_mode"))
        .unwrap_or_else(|| "unknown".to_string());

    let process = ProcessItem {
        id: "1".to_string(),
        user: "local".to_string(),
        host: "embedded".to_string(),
        db: "main".to_string(),
        command: "sqlite_in_process".to_string(),
        time_seconds: 0,
        state: format!("ready (journal_mode: {journal_mode})"),
        info: "-- SQLite is an embedded single-process database --".to_string(),
        wait_event: None,
        is_blocked: false,
        blocked_by: None,
    };

    Ok(ProcessListSummary {
        dialect: "sqlite".to_string(),
        total_connections: 1,
        active_queries: 0,
        blocked_queries: 0,
        longest_running_seconds: 0,
        processes: vec![process],
    })
}

/// Safely cancel a running query without terminating the client connection session.
#[tauri::command]
pub async fn kill_process_query(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    process_id: String,
) -> Result<KillResult, String> {
    let (conn, dialect) = {
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), ctx.dialect().to_string())
    };

    // Sanitize process_id to prevent SQL injection
    let pid_num = process_id
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("Invalid process ID format: '{process_id}'"))?;

    match dialect.as_str() {
        "postgres" => {
            let sql = format!("SELECT pg_cancel_backend({pid_num}) AS cancelled;");
            let raw_res = execute_raw_sql_pooled(&conn, sql).await?;
            let rows = rows_of(&raw_res);
            let cancelled = rows
                .first()
                .map(|r| extract_str(r, "cancelled") == "true")
                .unwrap_or(false);

            if cancelled {
                Ok(KillResult {
                    success: true,
                    target_id: process_id,
                    action: "cancel_query".to_string(),
                    message: format!("Query cancel signal sent successfully to PID {pid_num}."),
                })
            } else {
                Err(format!("Could not cancel query on PID {pid_num}. The process may have already completed."))
            }
        }
        "mysql" => {
            let sql = format!("KILL QUERY {pid_num};");
            execute_raw_sql_pooled(&conn, sql).await?;
            Ok(KillResult {
                success: true,
                target_id: process_id,
                action: "cancel_query".to_string(),
                message: format!("Query cancelled successfully on connection {pid_num}."),
            })
        }
        "sqlite" => Err("Cancel query is not supported on embedded SQLite instances.".to_string()),
        other => Err(format!("Unsupported database dialect: {other}")),
    }
}

/// Terminate the entire connection session (disconnect client).
#[tauri::command]
pub async fn kill_process_connection(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    process_id: String,
) -> Result<KillResult, String> {
    let (conn, dialect) = {
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), ctx.dialect().to_string())
    };

    let pid_num = process_id
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("Invalid process ID format: '{process_id}'"))?;

    match dialect.as_str() {
        "postgres" => {
            let sql = format!("SELECT pg_terminate_backend({pid_num}) AS terminated;");
            let raw_res = execute_raw_sql_pooled(&conn, sql).await?;
            let rows = rows_of(&raw_res);
            let terminated = rows
                .first()
                .map(|r| extract_str(r, "terminated") == "true")
                .unwrap_or(false);

            if terminated {
                Ok(KillResult {
                    success: true,
                    target_id: process_id,
                    action: "kill_connection".to_string(),
                    message: format!("Session {pid_num} terminated successfully."),
                })
            } else {
                Err(format!("Could not terminate PID {pid_num}. It may have already exited."))
            }
        }
        "mysql" => {
            let sql = format!("KILL CONNECTION {pid_num};");
            execute_raw_sql_pooled(&conn, sql).await?;
            Ok(KillResult {
                success: true,
                target_id: process_id,
                action: "kill_connection".to_string(),
                message: format!("Connection {pid_num} terminated successfully."),
            })
        }
        "sqlite" => Err("Terminating connections is not supported on embedded SQLite instances.".to_string()),
        other => Err(format!("Unsupported database dialect: {other}")),
    }
}
