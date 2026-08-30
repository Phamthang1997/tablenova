//! Running SQL the user typed: one statement, several statements, or streaming the results back in batches.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use tauri::ipc::Channel;

use crate::database::{
    execute_raw_sql_generic, run_bound_query, split_sql_statements, stmt_timeout,
    stream_sql_statements, timeout_msg, with_timeout,
};

#[tauri::command]
pub async fn execute_query(
    conn_id: String,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn_type, limit) = {
            let ctx = state.connections.acquire(&conn_id)?;
            (ctx.conn().clone(), stmt_timeout(&ctx.server().config()))
        };

        // With parameters -> bind at the driver level (parameterized, one statement). Without -> keep the old behaviour.
        let params = params.unwrap_or_default();
        let results = if params.is_empty() {
            with_timeout(limit, execute_raw_sql_generic(&conn_type, sql.clone())).await?
        } else {
            with_timeout(limit, run_bound_query(&conn_type, sql.clone(), &params)).await?
        };
        Ok(json!({ "success": true, "results": results }))
    })
    .await
}

// Run several SQL statements, each returning its own result set (feeding SqlEditor's multiple result tabs)
#[tauri::command]
pub async fn execute_multi_query(conn_id: String, sql: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn_type, limit) = {
            let ctx = state.connections.acquire(&conn_id)?;
            (ctx.conn().clone(), stmt_timeout(&ctx.server().config()))
        };

        let statements = split_sql_statements(&sql);
        let mut results: Vec<Value> = Vec::new();

        for stmt in statements {
            // The limit applies to EACH statement, not to the batch: "Run all" over 50 short statements is not
            // one long-running statement, and adding their times together would kill exactly the batches that are
            // perfectly ordinary.
            match with_timeout(limit, execute_raw_sql_generic(&conn_type, stmt.clone())).await {
                Ok(mut res) => {
                    if let Some(first) = res.drain(..).next() {
                        let mut obj = first.as_object().cloned().unwrap_or_default();
                        obj.insert("query".to_string(), json!(stmt));
                        results.push(Value::Object(obj));
                    }
                }
                Err(e) => {
                    // Return the results that did run + the error message of the statement that failed
                    return Ok(json!({
                        "success": false,
                        "results": results,
                        "message": format!("Lỗi tại câu lệnh:\n{}\n\nChi tiết: {}", stmt, e)
                    }));
                }
            }
        }

        Ok(json!({ "success": true, "results": results }))
    })
    .await
}

// ---- Streaming SQL cho SQL Editor ----
// Run (several) statements and PUSH the results batch by batch over a Channel to the frontend instead of collecting everything and returning once.
// That way the first rows appear almost instantly, the UI never freezes, and the run can be STOPPED midway through cancel_query.
// The message protocol on the channel (every message has a "type" field):
//   { type:"columns", stmtIndex, query, columns:[...] }   -> one statement begins
//   { type:"rows",    stmtIndex, rows:[{...}, ...] }        -> one batch of data
//   { type:"done",    stmtCount, cancelled }                -> every statement is finished
//   { type:"error",   stmtIndex, message }                  -> an error, the stream stops
#[tauri::command]
pub async fn execute_query_stream(
    conn_id: String,
    sql: String,
    query_id: String,
    channel: Channel<Value>,
    params: Option<Vec<Value>>,
) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let (conn_type, limit) = {
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), stmt_timeout(&ctx.server().config()))
    };

    // Register the cancel flag so cancel_query can stop the running stream loop
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(query_id.clone(), cancel_flag.clone());
    }

    // On timeout it raises the very flag `cancel_query` raises, so the stream loop stops through the same path
    // — no second stop branch is added where the rows are being pushed. `timed_out` tells "timed out" apart
    // from "the user pressed Stop": those two have to show two different messages.
    //
    // The limit covers the whole statement, including the part that is pushing rows back — exactly like the server's
    // `statement_timeout`, which likewise does not stop counting once the first rows arrive.
    let timed_out = Arc::new(AtomicBool::new(false));
    let timer = limit.map(|d| {
        let flag = cancel_flag.clone();
        let fired = timed_out.clone();
        tokio::spawn(async move {
            tokio::time::sleep(d).await;
            fired.store(true, Ordering::Relaxed);
            flag.store(true, Ordering::Relaxed);
        })
    });

    let params = params.unwrap_or_default();
    let outcome = stream_sql_statements(&conn_type, &sql, &params, &channel, &cancel_flag).await;
    // If it finishes early the timer has nothing left to do; leaving it running would raise the cancel flag of a later run.
    if let Some(t) = timer {
        t.abort();
    }

    // Always remove the flag when finished (whether it succeeded or failed)
    if let Ok(mut flags) = state.cancel_flags.lock() {
        flags.remove(&query_id);
    }

    match outcome {
        Ok((stmt_count, cancelled)) => {
            // A timeout leaves through the `error` shape, not `done{cancelled}`: the user did not press
            // Stop, and telling them they did sends them looking for a button that does not exist.
            if let (true, Some(d)) = (timed_out.load(Ordering::Relaxed), limit) {
                let _ = channel.send(json!({ "type": "error", "stmtIndex": stmt_count, "message": timeout_msg(d) }));
                return Ok(json!({ "success": false }));
            }
            let _ = channel.send(json!({ "type": "done", "stmtCount": stmt_count, "cancelled": cancelled }));
            Ok(json!({ "success": true }))
        }
        Err((stmt_index, msg)) => {
            let _ = channel.send(json!({ "type": "error", "stmtIndex": stmt_index, "message": msg }));
            Ok(json!({ "success": false }))
        }
    }
}).await
}

// Mark a streaming query as needing to stop. Not an error when query_id no longer exists.
#[tauri::command]
pub async fn cancel_query(query_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        if let Some(flag) = flags.get(&query_id) {
            flag.store(true, Ordering::Relaxed);
        }
        Ok(json!({ "success": true }))
    })
    .await
}
