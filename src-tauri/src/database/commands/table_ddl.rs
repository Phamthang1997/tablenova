//! DDL cấp bảng: tạo / xoá / làm rỗng / đổi tên, và đọc lại DDL của bảng.

use serde_json::{json, Value};
use sqlx::Row;

use crate::database::{
    all_string_values, execute_raw_sql_generic, fk_checks_sql, pg_schema_of, qualified,
    quote_ident, reject_conn_read_only, sql_str, DbConnection, DbKind, Exec,
};

use super::catalog::get_primary_key_columns;
use super::table_alter::generate_alter_sqls;

#[tauri::command]
pub async fn create_table(state: tauri::State<'_, crate::AppState>, conn_id: String, payload: Value) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };

    let table_name = payload.get("tableName").and_then(|v| v.as_str()).ok_or("Thiếu tên bảng")?;

    let db_type = match &conn_type.kind {
        DbKind::Sqlite(_) => "sqlite",
        DbKind::Postgres(_) => "postgres",
        DbKind::Mysql(_) => "mysql",
    };
    let q = if db_type == "mysql" { '`' } else { '"' };
    // Không qualify thì bảng mới rơi vào schema đầu search_path, không phải schema đang chọn.
    let table_ref = qualified(&conn_type, &schema, table_name);

    let columns = payload.get("columns").and_then(|v| v.as_array());

    // Nếu không truyền cột nào -> giữ hành vi cũ: tạo bảng tối thiểu với 1 cột id khóa chính
    let create_sql = match columns {
        Some(cols) if !cols.is_empty() => {
            // Danh sách cột khóa chính
            let pk_cols: Vec<String> = cols.iter()
                .filter(|c| c.get("isPrimaryKey").and_then(|v| v.as_bool()).unwrap_or(false))
                .filter_map(|c| c.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect();
            // Trường hợp đặc biệt: đúng 1 khóa chính và có tự tăng -> dùng cú pháp auto-increment ngay trên cột đó
            let single_auto_pk = pk_cols.len() == 1
                && cols.iter().any(|c| {
                    c.get("isPrimaryKey").and_then(|v| v.as_bool()).unwrap_or(false)
                        && c.get("autoIncrement").and_then(|v| v.as_bool()).unwrap_or(false)
                });

            let mut defs: Vec<String> = Vec::new();
            for col in cols {
                let name = match col.get("name").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
                    Some(n) => n,
                    None => continue,
                };
                let col_type = col.get("type").and_then(|v| v.as_str()).unwrap_or("TEXT");
                let is_pk = col.get("isPrimaryKey").and_then(|v| v.as_bool()).unwrap_or(false);
                let nullable = col.get("nullable").and_then(|v| v.as_bool()).unwrap_or(true);
                let default_val = col.get("defaultValue").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());

                if single_auto_pk && is_pk {
                    // Cột khóa chính tự tăng: cú pháp riêng theo từng dialect
                    let def = match db_type {
                        "mysql" => format!("{q}{name}{q} {ty} NOT NULL AUTO_INCREMENT PRIMARY KEY", q = q, name = name, ty = col_type),
                        "postgres" => format!("{q}{name}{q} SERIAL PRIMARY KEY", q = q, name = name),
                        _ => format!("{q}{name}{q} INTEGER PRIMARY KEY AUTOINCREMENT", q = q, name = name),
                    };
                    defs.push(def);
                    continue;
                }

                let mut def = format!("{q}{name}{q} {ty}", q = q, name = name, ty = col_type);
                if !nullable {
                    def.push_str(" NOT NULL");
                }
                if let Some(d) = default_val {
                    if d.eq_ignore_ascii_case("CURRENT_TIMESTAMP") || d == "0" || d.eq_ignore_ascii_case("true") || d.eq_ignore_ascii_case("false") || d == "''" {
                        def.push_str(&format!(" DEFAULT {}", d));
                    } else {
                        def.push_str(&format!(" DEFAULT '{}'", d.replace('\'', "''")));
                    }
                }
                defs.push(def);
            }

            // Nếu có nhiều khóa chính (hoặc khóa chính không tự tăng) -> thêm ràng buộc PRIMARY KEY ở cấp bảng
            if !single_auto_pk && !pk_cols.is_empty() {
                let pk_list = pk_cols.iter().map(|c| format!("{q}{c}{q}", q = q, c = c)).collect::<Vec<_>>().join(", ");
                defs.push(format!("PRIMARY KEY ({})", pk_list));
            }

            format!("CREATE TABLE {name} ({defs})", name = table_ref, defs = defs.join(", "))
        }
        _ => match &conn_type.kind {
            DbKind::Mysql(_) => format!("CREATE TABLE {} (id INT AUTO_INCREMENT PRIMARY KEY)", table_ref),
            _ => format!("CREATE TABLE {} (id INTEGER PRIMARY KEY)", table_ref),
        },
    };

    execute_raw_sql_generic(&conn_type, create_sql).await?;

    // Sau khi tạo bảng, tạo tiếp Index & Foreign Key (nếu có) — tái dùng bộ sinh SQL đã sửa ở generate_alter_sqls
    let extra_payload = json!({
        "addedIndexes": payload.get("indexes").cloned().unwrap_or(json!([])),
        "addedFKs": payload.get("foreignKeys").cloned().unwrap_or(json!([])),
    });
    let extra_sqls = generate_alter_sqls(table_name, &extra_payload, db_type, &schema);
    for sql in extra_sqls {
        execute_raw_sql_generic(&conn_type, sql).await?;
    }

    Ok(json!({ "success": true }))
}

/// Runs a short sequence on ONE connection, optionally with foreign-key checks turned off around it.
///
/// Two requirements, and the pool satisfies neither on its own:
///  - **One connection**, or `SET FOREIGN_KEY_CHECKS` lands on a different session than the
///    statement it is meant to wrap and quietly does nothing.
///  - **The pinned session when the user is in manual-commit mode.** Taking a fresh connection
///    there would run the DROP/TRUNCATE outside their transaction and commit it — "manual commit"
///    that commits by itself. Note this is `use_session()`, not `is_open()`: the transaction does
///    not exist until its first statement, and this may well be that statement.
///
/// `optional` runs only if the main statement succeeded and its own failure is ignored.
async fn run_fk_wrapped(
    conn: &DbConnection,
    disable_fk: bool,
    sql: String,
    optional: Option<String>,
) -> Result<(), String> {
    // Before the FK-disable statement, not after: refusing halfway would leave the session with
    // foreign-key checks off on a connection we just declared untouchable.
    reject_conn_read_only(conn)?;
    if crate::tx::use_session(conn) {
        // execute_raw_sql_generic routes to the pinned session, so all of these share one
        // connection exactly like the `Exec` branch below.
        if disable_fk {
            let _ = execute_raw_sql_generic(conn, fk_checks_sql(conn, false).to_string()).await;
        }
        let result = execute_raw_sql_generic(conn, sql).await;
        if result.is_ok() {
            if let Some(extra) = optional {
                let _ = execute_raw_sql_generic(conn, extra).await;
            }
        }
        // Restore even on failure: the session lives on and later statements must not inherit a
        // disabled foreign-key check.
        if disable_fk {
            let _ = execute_raw_sql_generic(conn, fk_checks_sql(conn, true).to_string()).await;
        }
        return result.map(|_| ());
    }

    let mut exec = Exec::acquire(conn).await?;
    if disable_fk {
        exec.try_run(fk_checks_sql(conn, false)).await;
    }
    let result = exec.run(sql).await;
    if result.is_ok() {
        if let Some(extra) = optional {
            exec.try_run(&extra).await;
        }
    }
    // Khôi phục kể cả khi lỗi: connection quay lại pool (hoặc là handle SQLite dùng chung),
    // nếu không lệnh sau sẽ chạy trên session còn tắt kiểm tra khóa ngoại.
    if disable_fk {
        exec.try_run(fk_checks_sql(conn, true)).await;
    }
    result
}

// Xóa bảng/view. `cascade` và `ignore_fk` là 2 tuỳ chọn của dialog Delete ở sidebar.
#[tauri::command]
pub async fn drop_table(
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    name: String,
    is_view: Option<bool>,
    cascade: Option<bool>,
    ignore_fk: Option<bool>,
) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };
    let is_view = is_view.unwrap_or(false);
    let cascade = cascade.unwrap_or(false);
    // Bỏ qua khóa ngoại không có nghĩa với view: view không nằm trong ràng buộc FK nào.
    let ignore_fk = ignore_fk.unwrap_or(false) && !is_view;

    // CASCADE chỉ Postgres mới thực thi thật: SQLite báo lỗi cú pháp, MySQL chấp nhận từ khóa
    // rồi bỏ qua -> người dùng tưởng đã xóa lan mà thực tế không. Từ chối còn hơn im lặng.
    if cascade && !matches!(conn_type.kind, DbKind::Postgres(_)) {
        return Err("CASCADE chỉ được hỗ trợ trên PostgreSQL".to_string());
    }

    let keyword = if is_view { "DROP VIEW" } else { "DROP TABLE" };
    let sql = format!(
        "{} {}{}",
        keyword,
        qualified(&conn_type, &schema, &name),
        if cascade { " CASCADE" } else { "" }
    );

    run_fk_wrapped(&conn_type, ignore_fk, sql, None).await?;

    Ok(json!({ "success": true }))
}

// Giá trị AUTO_INCREMENT kế tiếp của một bảng MySQL, None nếu bảng không có cột tự tăng.
// Chỉ đọc (SELECT) nên chạy qua execute_raw_sql_generic được, không cần chung session với TRUNCATE.
async fn mysql_next_auto_increment(conn: &DbConnection, name: &str) -> Option<u64> {
    let sql = format!(
        "SELECT AUTO_INCREMENT AS ai FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}'",
        name.replace('\'', "''")
    );
    let results = execute_raw_sql_generic(conn, sql).await.ok()?;
    let cell = results.first()?.get("data")?.as_array()?.first()?.get("ai")?;
    // decode_mysql_cell! trả u64 thành số, nhưng nhận cả chuỗi cho chắc.
    cell.as_u64().or_else(|| cell.as_str()?.parse().ok())
}

// Xóa sạch dữ liệu nhưng giữ cấu trúc bảng.
// `restart_identity` / `disable_fk` / `cascade` là 3 tuỳ chọn của dialog Truncate ở sidebar.
#[tauri::command]
pub async fn truncate_table(
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    name: String,
    restart_identity: Option<bool>,
    disable_fk: Option<bool>,
    cascade: Option<bool>,
) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };
    let restart_identity = restart_identity.unwrap_or(false);
    let disable_fk = disable_fk.unwrap_or(false);
    let cascade = cascade.unwrap_or(false);
    let quoted = qualified(&conn_type, &schema, &name);

    // Như DROP: chỉ Postgres có TRUNCATE ... CASCADE.
    if cascade && !matches!(conn_type.kind, DbKind::Postgres(_)) {
        return Err("CASCADE chỉ được hỗ trợ trên PostgreSQL".to_string());
    }

    // MySQL luôn reset bộ đếm tự tăng bên trong TRUNCATE và không có cách tắt, nên "giữ nguyên
    // bộ đếm" phải làm thủ công: đọc giá trị trước, đặt lại sau. Đọc TRƯỚC khi truncate.
    let keep_auto_inc = match (&conn_type.kind, restart_identity) {
        (DbKind::Mysql(_), false) => mysql_next_auto_increment(&conn_type, &name).await,
        _ => None,
    };

    // Câu lệnh bắt buộc + câu lệnh "cố gắng" chạy sau (lỗi không tính là thất bại).
    let (sql, optional): (String, Option<String>) = match &conn_type.kind {
        DbKind::Mysql(_) => (
            format!("TRUNCATE TABLE {}", quoted),
            match (restart_identity, keep_auto_inc) {
                // InnoDB đã reset sẵn; vẫn phát lệnh để ý định rõ ràng và các engine khác hành xử
                // giống nhau. Bảng không có cột tự tăng -> bỏ qua lỗi.
                (true, _) => Some(format!("ALTER TABLE {} AUTO_INCREMENT = 1", quoted)),
                // Đặt lại giá trị cũ để id mới không dùng lại id đã xóa.
                (false, Some(v)) if v > 1 => {
                    Some(format!("ALTER TABLE {} AUTO_INCREMENT = {}", quoted, v))
                }
                _ => None,
            },
        ),
        DbKind::Postgres(_) => (
            format!(
                "TRUNCATE TABLE {}{}{}",
                quoted,
                if restart_identity { " RESTART IDENTITY" } else { "" },
                if cascade { " CASCADE" } else { "" }
            ),
            None,
        ),
        // SQLite không có TRUNCATE -> DELETE FROM, và bộ đếm tự tăng nằm ở bảng phụ
        // sqlite_sequence mà DELETE không đụng tới. Bảng này chỉ tồn tại khi CSDL có
        // ít nhất một cột AUTOINCREMENT -> bỏ qua lỗi "no such table".
        DbKind::Sqlite(_) => (
            format!("DELETE FROM {}", quoted),
            restart_identity.then(|| {
                format!("DELETE FROM sqlite_sequence WHERE name = '{}'", name.replace('\'', "''"))
            }),
        ),
    };

    run_fk_wrapped(&conn_type, disable_fk, sql, optional).await?;

    Ok(json!({ "success": true }))
}

// Trả về câu lệnh CREATE TABLE (định nghĩa) của bảng theo từng dialect
#[tauri::command]
pub async fn get_table_definition(state: tauri::State<'_, crate::AppState>, conn_id: String, name: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };
    let sch = sql_str(&pg_schema_of(&schema));

    let ddl: String = match &conn_type.kind {
        DbKind::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query([name.as_str()]).map_err(|e| e.to_string())?;
            if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let s: String = row.get(0).map_err(|e| e.to_string())?;
                format!("{};", s)
            } else {
                return Err("Không tìm thấy định nghĩa bảng".to_string());
            }
        }
        DbKind::Mysql(pool) => {
            let show_sql = format!("SHOW CREATE TABLE `{}`", name);
            let row = sqlx::query(sqlx::AssertSqlSafe(show_sql)).fetch_one(pool).await.map_err(|e| e.to_string())?;
            // Cột thứ 2 là "Create Table" (bảng) hoặc "Create View" (view)
            let s: String = row.try_get("Create Table").or_else(|_| row.try_get("Create View")).map_err(|e| e.to_string())?;
            format!("{};", s)
        }
        DbKind::Postgres(_) => {
            // A view is NOT a table here. This branch used to hand-build `CREATE TABLE` for
            // every name it was given, so exporting a Postgres database emitted a CREATE TABLE
            // for each of its views — the re-import then had a real table shadowing the view
            // and none of the view logic. relkind decides: 'v' = view, 'm' = materialized view
            // (which CREATE ... WITH DATA populates on the spot, so no REFRESH is needed as
            // long as it is written after the tables it reads — which the dump order does).
            let relkind = {
                let sql = format!(
                    "SELECT c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = '{}' AND c.relname = '{}' LIMIT 1",
                    sch, name.replace('\'', "''")
                );
                execute_raw_sql_generic(&conn_type, sql)
                    .await
                    .ok()
                    .and_then(|r| all_string_values(&r).into_iter().next())
                    .unwrap_or_default()
            };
            if relkind == "v" || relkind == "m" {
                // regclass resolves through search_path unless the name is qualified, which would
                // read a same-named view from another schema. The emitted DDL below stays
                // unqualified on purpose: the dump header sets search_path, so the file can be
                // restored into a differently-named schema.
                let sql = format!(
                    "SELECT pg_get_viewdef('\"{}\".\"{}\"'::regclass, true) AS def",
                    sch.replace('"', "\"\""),
                    name.replace('"', "\"\"")
                );
                let results = execute_raw_sql_generic(&conn_type, sql).await?;
                let body = all_string_values(&results)
                    .into_iter()
                    .next()
                    .ok_or("Không lấy được định nghĩa đối tượng")?;
                let body = body.trim().trim_end_matches(';');
                let kw = if relkind == "m" { "MATERIALIZED VIEW" } else { "VIEW" };
                return Ok(json!({
                    "success": true,
                    "sql": format!("CREATE {} \"{}\" AS\n{};", kw, name.replace('"', "\"\""), body)
                }));
            }

            // Postgres không có SHOW CREATE TABLE -> dựng lại từ metadata (cột + NOT NULL + DEFAULT + PRIMARY KEY)
            let pk_cols = get_primary_key_columns(&conn_type, &schema, &name).await;
            // format_type() keeps length/precision — see get_table_schema for why.
            let sql = format!(
                "SELECT a.attname::text AS column_name, \
                        format_type(a.atttypid, a.atttypmod) AS data_type, \
                        CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable, \
                        pg_get_expr(d.adbin, d.adrelid) AS column_default \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE n.nspname = '{}' AND c.relname = '{}' \
                   AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
                sch, name.replace('\'', "''")
            );
            let results = execute_raw_sql_generic(&conn_type, sql).await?;
            let mut defs: Vec<String> = Vec::new();
            if let Some(data) = results.get(0).and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
                for row in data {
                    let o = match row.as_object() { Some(o) => o, None => continue };
                    let col = o.get("column_name").and_then(|v| v.as_str()).unwrap_or("");
                    let ty = o.get("data_type").and_then(|v| v.as_str()).unwrap_or("text");
                    let nullable = o.get("is_nullable").and_then(|v| v.as_str()).unwrap_or("YES") == "YES";
                    let default = o.get("column_default").and_then(|v| v.as_str());
                    let mut def = format!("  \"{}\" {}", col, ty);
                    if !nullable { def.push_str(" NOT NULL"); }
                    if let Some(d) = default { def.push_str(&format!(" DEFAULT {}", d)); }
                    defs.push(def);
                }
            }
            if !pk_cols.is_empty() {
                let pk_list = pk_cols.iter().map(|c| format!("\"{}\"", c)).collect::<Vec<_>>().join(", ");
                defs.push(format!("  PRIMARY KEY ({})", pk_list));
            }
            format!("CREATE TABLE \"{}\" (\n{}\n);", name, defs.join(",\n"))
        }
    };

    Ok(json!({ "success": true, "sql": ddl }))
}

#[tauri::command]
pub async fn rename_table(state: tauri::State<'_, crate::AppState>, conn_id: String, old_name: String, new_name: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };

    // Chỉ vế nguồn mang schema: RENAME TO nhận tên mới KHÔNG qualify (Postgres báo lỗi cú pháp
    // nếu qualify), bảng đổi tên vẫn ở nguyên schema cũ.
    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => format!("RENAME TABLE `{}` TO `{}`", old_name, new_name),
        _ => format!(
            "ALTER TABLE {} RENAME TO {}",
            qualified(&conn_type, &schema, &old_name),
            quote_ident(&conn_type, &new_name)
        ),
    };
    execute_raw_sql_generic(&conn_type, sql.clone()).await?;
    
    Ok(json!({ "success": true }))
}
