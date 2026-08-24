//! Funnel 3: đẩy kết quả về frontend theo lô trong lúc truy vấn còn đang chạy.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::TryStreamExt;
use rusqlite::Connection as SqliteConnection;
use serde_json::{json, Value};
use sqlx::{Column, Executor, Row, SqlSafeStr, Statement, ValueRef};
use tauri::ipc::Channel;

use super::super::conn::{DbConnection, DbKind};
use super::super::decode::{bind_mysql_params, bind_pg_params, decode_mysql_cell, decode_pg_cell, json_to_sqlite_value};
use super::super::read_only::reject_if_read_only;
use super::super::rows::uniquify_columns;
use super::super::splitter::split_sql_statements;

// Số dòng gom lại trước mỗi lần đẩy batch qua Channel về frontend khi stream kết quả SQL.
const STREAM_BATCH: usize = 500;

// Tách và stream lần lượt từng câu lệnh. Trả về (số câu lệnh đã chạy, có bị hủy không).
// Lỗi trả về (chỉ số câu lệnh gặp lỗi, thông báo).
pub(crate) async fn stream_sql_statements(
    conn: &DbConnection,
    sql: &str,
    params: &[Value],
    channel: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<(usize, bool), (usize, String)> {
    let statements = split_sql_statements(sql);
    // Tham số truy vấn (parameterized) chỉ hỗ trợ đúng MỘT câu lệnh: binding theo vị trí
    // không thể phân bổ an toàn qua nhiều câu lệnh. Báo lỗi rõ ràng thay vì đoán mò.
    if !params.is_empty() && statements.len() > 1 {
        return Err((0, "Tham số truy vấn chỉ hỗ trợ một câu lệnh. Vui lòng chạy từng câu lệnh riêng hoặc tắt Tham số Truy vấn.".to_string()));
    }
    let mut idx = 0usize;
    for stmt in statements {
        if cancel.load(Ordering::Relaxed) {
            return Ok((idx, true));
        }
        // params chỉ áp cho câu lệnh duy nhất (đã chặn multi-statement ở trên).
        stream_one_statement(conn, &stmt, params, idx, channel, cancel)
            .await
            .map_err(|e| (idx, e))?;
        idx += 1;
    }
    Ok((idx, cancel.load(Ordering::Relaxed)))
}

// Stream kết quả của MỘT câu lệnh: emit "columns" rồi các batch "rows".
pub(crate) async fn stream_one_statement(
    conn: &DbConnection,
    sql: &str,
    params: &[Value],
    stmt_index: usize,
    channel: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    reject_if_read_only(conn, sql)?;
    // Manual transaction mode: this is the SQL editor's path, so it is the one where the user
    // actually types BEGIN/COMMIT. See tx_session.rs.
    if crate::tx_session::should_route(conn, sql) {
        return crate::tx_session::run_stream(conn, sql, params, stmt_index, channel, cancel).await;
    }
    match &conn.kind {
        DbKind::Sqlite(conn_arc) => sqlite_stream(conn_arc, sql, params, stmt_index, channel, cancel).await,
        DbKind::Postgres(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            pg_stream(&mut conn, sql, params, stmt_index, channel, cancel).await
        }
        DbKind::Mysql(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            mysql_stream(&mut conn, sql, params, stmt_index, channel, cancel).await
        }
    }
}

// Split out of `stream_one_statement` so the pinned transaction session runs the same body.
// SQLite needs no pinning — `DbKind::Sqlite` is one shared handle already.

pub(crate) async fn sqlite_stream(
    conn_arc: &Arc<Mutex<SqliteConnection>>,
    sql: &str,
    params: &[Value],
    stmt_index: usize,
    channel: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    // rusqlite là đồng bộ -> chạy trong spawn_blocking để không chặn runtime async.
    let conn_arc = conn_arc.clone();
    let channel = channel.clone();
    let cancel = cancel.clone();
    let sql = sql.to_string();
    let sqlite_params: Vec<rusqlite::types::Value> = params.iter().map(json_to_sqlite_value).collect();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let c = conn_arc.lock().map_err(|e| e.to_string())?;
        let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
        let col_count = stmt.column_count();
        // Câu lệnh không trả về cột (INSERT/UPDATE/DELETE/DDL...) -> execute và báo số dòng ảnh hưởng.
        if col_count == 0 {
            let affected = stmt
                .execute(rusqlite::params_from_iter(sqlite_params.iter()))
                .map_err(|e| e.to_string())?;
            let _ = channel.send(json!({ "type": "affected", "stmtIndex": stmt_index, "query": sql, "affected": affected }));
            return Ok(());
        }
        let mut columns = Vec::with_capacity(col_count);
        for i in 0..col_count {
            columns.push(stmt.column_name(i).map_err(|e| e.to_string())?.to_string());
        }
        uniquify_columns(&mut columns);
        let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns }));

        let mut rows = stmt.query(rusqlite::params_from_iter(sqlite_params.iter())).map_err(|e| e.to_string())?;
        let mut batch: Vec<Value> = Vec::with_capacity(STREAM_BATCH);
        loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            match rows.next().map_err(|e| e.to_string())? {
                Some(row) => {
                    let mut map = serde_json::Map::new();
                    for i in 0..col_count {
                        let val: Value = match row.get_ref(i) {
                            Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                            Ok(rusqlite::types::ValueRef::Integer(n)) => json!(n),
                            Ok(rusqlite::types::ValueRef::Real(r)) => json!(r),
                            Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                            Ok(rusqlite::types::ValueRef::Blob(b)) => json!(b),
                            _ => Value::Null,
                        };
                        map.insert(columns[i].clone(), val);
                    }
                    batch.push(Value::Object(map));
                    if batch.len() >= STREAM_BATCH {
                        let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": std::mem::take(&mut batch) }));
                    }
                }
                None => break,
            }
        }
        if !batch.is_empty() {
            let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": batch }));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) async fn pg_stream(
    conn: &mut sqlx::PgConnection,
    sql: &str,
    params: &[Value],
    stmt_index: usize,
    channel: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let trimmed = sql.trim().to_uppercase();
    if trimmed.starts_with("USE ") || trimmed.starts_with("CREATE DATABASE") {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).execute(&mut *conn).await.map_err(|e| e.to_string())?;
        let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": Vec::<String>::new() }));
        return Ok(());
    }
    // Dò xem câu lệnh có trả về cột không (qua prepared statement). Nếu không -> execute + báo affected.
    let returns_rows = match (&mut *conn).prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
        Ok(st) => !st.columns().is_empty(),
        Err(_) => true, // prepare lỗi -> cứ thử fetch theo đường cũ
    };
    if !returns_rows {
        let r = bind_pg_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        let _ = channel.send(json!({ "type": "affected", "stmtIndex": stmt_index, "query": sql, "affected": r.rows_affected() }));
        return Ok(());
    }
    let mut columns: Vec<String> = Vec::new();
    let pg_query = bind_pg_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params);
    let mut stream = pg_query.fetch(&mut *conn);
    let mut batch: Vec<Value> = Vec::with_capacity(STREAM_BATCH);
    while let Some(r) = stream.try_next().await.map_err(|e| e.to_string())? {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if columns.is_empty() {
            for col in r.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
            let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns.clone() }));
        }
        let mut map = serde_json::Map::new();
        // Read by index: `columns` now holds the de-duplicated names, and reading by
        // name would hand back the first same-named column's value for every repeat.
        for (i, col_name) in columns.iter().enumerate() {
            let val: Value = decode_pg_cell!(&r, i);
            map.insert(col_name.clone(), val);
        }
        batch.push(Value::Object(map));
        if batch.len() >= STREAM_BATCH {
            let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": std::mem::take(&mut batch) }));
        }
    }
    // The row stream borrows the connection; it must be released before the connection can
    // be used again for the column-name probe below.
    drop(stream);
    if !batch.is_empty() {
        let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": batch }));
    }
    if columns.is_empty() {
        // Probe on THIS connection: inside a manual transaction a second pooled connection
        // would block on the locks this one holds.
        if let Ok(stmt) = (&mut *conn).prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
            for col in stmt.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
        }
        let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns }));
    }
    Ok(())
}

pub(crate) async fn mysql_stream(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    params: &[Value],
    stmt_index: usize,
    channel: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let trimmed = sql.trim().to_uppercase();
    if trimmed.starts_with("USE ") || trimmed.starts_with("CREATE DATABASE") {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).execute(&mut *conn).await.map_err(|e| e.to_string())?;
        let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": Vec::<String>::new() }));
        return Ok(());
    }
    // Dò xem câu lệnh có trả về cột không. Nếu không -> execute + báo affected.
    let returns_rows = match (&mut *conn).prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
        Ok(st) => !st.columns().is_empty(),
        Err(_) => {
            // Không prepare được (CREATE/DROP TRIGGER|PROCEDURE|FUNCTION|EVENT -> lỗi 1295,
            // hoặc cú pháp lỗi). Chạy bằng text protocol: đúng cho DDL, còn cú pháp sai thì
            // lỗi thật của server được trả về ở đây.
            let r = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
                .execute(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
            let _ = channel.send(json!({ "type": "affected", "stmtIndex": stmt_index, "query": sql, "affected": r.rows_affected() }));
            return Ok(());
        }
    };
    if !returns_rows {
        let r = bind_mysql_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        let _ = channel.send(json!({ "type": "affected", "stmtIndex": stmt_index, "query": sql, "affected": r.rows_affected() }));
        return Ok(());
    }
    let mut columns: Vec<String> = Vec::new();
    let mysql_query = bind_mysql_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params);
    let mut stream = mysql_query.fetch(&mut *conn);
    let mut batch: Vec<Value> = Vec::with_capacity(STREAM_BATCH);
    while let Some(r) = stream.try_next().await.map_err(|e| e.to_string())? {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if columns.is_empty() {
            for col in r.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
            let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns.clone() }));
        }
        let mut map = serde_json::Map::new();
        // Read by index — see the Postgres branch above.
        for (i, col_name) in columns.iter().enumerate() {
            let val: Value = decode_mysql_cell!(&r, i);
            map.insert(col_name.clone(), val);
        }
        batch.push(Value::Object(map));
        if batch.len() >= STREAM_BATCH {
            let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": std::mem::take(&mut batch) }));
        }
    }
    // See the Postgres branch: the stream borrows the connection.
    drop(stream);
    if !batch.is_empty() {
        let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": batch }));
    }
    if columns.is_empty() {
        if let Ok(stmt) = (&mut *conn).prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
            for col in stmt.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
        }
        let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns }));
    }
    Ok(())
}
