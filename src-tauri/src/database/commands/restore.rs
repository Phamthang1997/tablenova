//! `restore_backup` — phát lại một dump `.sql` nhiều câu lệnh, lọc theo bảng người dùng chọn.

use serde_json::{json, Value};
use sqlx::{MySqlPool, PgPool};
use tauri::ipc::Channel;

use crate::database::{
    build_mysql_url, build_pg_url, execute_raw_sql_generic, reject_conn_read_only,
    split_sql_statements, strip_leading_comments, DbConnection, DbKind,
};

/// Phần đầu câu lệnh, in hoa — đủ để phân loại bằng `is_skipped_stmt`/`is_session_level_stmt`.
///
/// Chỉ 4-5 từ đầu quyết định loại câu lệnh, nên `to_uppercase()` trên CẢ câu là vô ích và đắt:
/// nó cấp phát một bản copy của từng câu INSERT, tức là copy lại toàn bộ dump một lần nữa.
/// Từ khoá dài nhất cần so là `START TRANSACTION` (17 ký tự) nên 32 byte là đủ rộng.
fn upper_head(body: &str) -> String {
    let mut end = body.len().min(32);
    // Cắt theo byte thì phải lùi về biên ký tự UTF-8 (câu lệnh có thể mở đầu bằng ký tự nhiều byte).
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    body[..end].to_uppercase()
}

// Lệnh của dump mà restore KHÔNG được chạy lại:
//   - LOCK/UNLOCK TABLES: mysqldump thêm vào cho nhanh. `LOCK TABLES x WRITE` có tên bảng nên
//     lọt qua bộ lọc, còn `UNLOCK TABLES` thì không -> khoá treo lại và bảng kế tiếp bị lỗi
//     1100 "was not locked with LOCK TABLES". Bỏ cả cặp là an toàn nhất, nhất là khi người
//     dùng chỉ chọn một phần bảng.
//   - BEGIN/START TRANSACTION/COMMIT/ROLLBACK: transaction do chính hàm này quản lý; chạy lại
//     lệnh của dump (nhất là ROLLBACK) có thể huỷ phần đã nhập.
/// Statement text as it appears in an error message.
///
/// The framing is `Lỗi khi chạy lệnh SQL: {statement}. Chi tiết: {cause}` (kept verbatim so the
/// regex in `backendErrors.ts` still matches), which puts the statement first — and a multi-row
/// INSERT is now hundreds of KB, so the cause was pushed far below the visible area of the error
/// dialog and users saw a wall of VALUES with no reason attached. Only the head is needed to
/// recognise which statement failed.
///
/// The marker is a bare `…` on purpose: any word here would be a user-visible string escaping
/// through the error channel untranslated, and `backendErrors.ts` matches this message with a
/// regex that passes the interpolated text straight through.
fn stmt_for_error(stmt: &str) -> String {
    const MAX: usize = 400;
    if stmt.len() <= MAX {
        return stmt.to_string();
    }
    let mut end = MAX;
    while end > 0 && !stmt.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &stmt[..end])
}

fn is_skipped_stmt(stmt_upper: &str) -> bool {
    stmt_upper.starts_with("LOCK TABLES")
        || stmt_upper.starts_with("UNLOCK TABLES")
        || stmt_upper.starts_with("START TRANSACTION")
        || stmt_upper == "BEGIN"
        || stmt_upper.starts_with("BEGIN;")
        || stmt_upper.starts_with("BEGIN WORK")
        || stmt_upper.starts_with("COMMIT")
        || stmt_upper.starts_with("ROLLBACK")
}

// Lệnh cấp phiên/schema trong một tệp dump: luôn chạy dù người dùng chỉ chọn một phần bảng
// (không nhắc tên bảng nào nên bộ lọc theo bảng sẽ bỏ sót), và lỗi của chúng KHÔNG huỷ cả
// lần restore — dump của dialect khác thường có `SET NAMES`/`SET @@...` mà server hiện tại
// không hiểu, còn `CREATE SCHEMA` thì lỗi nếu schema đã tồn tại.
fn is_session_level_stmt(stmt_upper: &str) -> bool {
    stmt_upper.starts_with("USE ")
        || stmt_upper.starts_with("SET ")
        // PRAGMA is the SQLite spelling of the same thing — the header this app writes opens
        // with `PRAGMA foreign_keys = OFF;`, which names no table and would otherwise be
        // filtered out. A PRAGMA the current server does not know must not abort the restore
        // either, which is exactly what this list means.
        || stmt_upper.starts_with("PRAGMA ")
        || stmt_upper.starts_with("CREATE DATABASE")
        || stmt_upper.starts_with("CREATE SCHEMA")
}

// Câu lệnh có nhắc tới một trong các bảng được chọn không (so khớp theo biên từ để
// `film` không khớp `film_actor`).
//
// Regex được biên dịch MỘT lần cho cả lần restore, không phải theo từng cặp (câu lệnh × bảng):
// một dump 10MB có ~50.000 câu lệnh, nhân 22 bảng là hơn một triệu lần `Regex::new()` — bước
// lọc này từng tốn nhiều thời gian hơn cả lúc chạy SQL thật, và nó xảy ra TRƯỚC khi gửi
// `start` về UI nên người dùng chỉ thấy "Đang chuẩn bị..." đứng im.
pub(crate) struct TableMatcher {
    /// Một regex alternation cho tất cả bảng: quét mỗi câu lệnh một lượt thay vì một lượt/bảng.
    re: Option<regex::Regex>,
    /// Dự phòng khi regex không dựng được (tên bảng quá lạ / danh sách quá lớn).
    lowered: Vec<String>,
}

impl TableMatcher {
    pub(crate) fn new(tables: &[String]) -> Self {
        if tables.is_empty() {
            return Self { re: None, lowered: Vec::new() };
        }
        let alts: Vec<String> = tables.iter().map(|t| regex::escape(t)).collect();
        // (?i) thay cho việc lowercase từng câu lệnh: `to_lowercase()` cấp phát một bản copy
        // của mỗi câu INSERT, tức là copy lại cả dump.
        let re = regex::Regex::new(&format!(r"(?i)\b(?:{})\b", alts.join("|"))).ok();
        Self {
            re,
            lowered: tables.iter().map(|t| t.to_lowercase()).collect(),
        }
    }

    pub(crate) fn matches(&self, stmt: &str) -> bool {
        if let Some(re) = &self.re {
            return re.is_match(stmt);
        }
        let lower = stmt.to_lowercase();
        self.lowered.iter().any(|t| lower.contains(t))
    }
}

// Tên database trong lệnh `USE <db>` (để reconnect sau khi restore xong).
fn use_db_name(stmt: &str) -> Option<String> {
    let parts: Vec<&str> = stmt.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let name = parts[1]
        .trim_matches(|c| c == ';' || c == '`' || c == '"' || c == '\'')
        .to_string();
    if name.is_empty() { None } else { Some(name) }
}

#[tauri::command]
pub async fn restore_backup(
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    sql_content: String,
    tables: Vec<String>,
    // Kênh báo tiến độ về UI: {type:'start'|'progress'|'done', done, total}. Restore là một
    // lần gọi dài nên không có kênh thì UI chỉ vẽ được thanh vô định.
    // Bắt buộc (không dùng Option): Channel không impl Deserialize nên `Option<Channel<_>>`
    // không thoả CommandArg — frontend luôn tạo kênh, có cần dùng hay không thì tuỳ nó.
    on_progress: Channel<Value>,
    // Gặp lệnh lỗi thì bỏ qua và chạy tiếp, thay vì rollback toàn bộ (giống `mysql --force`).
    //
    // KHÔNG phải "tắt kiểm tra toàn vẹn": khoá ngoại vốn đã tắt sẵn ở mọi lần restore
    // (`SET FOREIGN_KEY_CHECKS = 0` / `SET CONSTRAINTS ALL DEFERRED` / `PRAGMA foreign_keys OFF`).
    // Thứ thật sự làm hỏng cả lần nhập là những lỗi không tắt được: `CREATE VIEW` đọc bảng
    // không có trong tệp, routine gọi hàm chưa tồn tại, kiểu dữ liệu server này không hiểu.
    // Chế độ này cứu lấy phần chạy được, đổi lại mất tính nguyên tử.
    continue_on_error: Option<bool>,
) -> Result<Value, String> {
    let continue_on_error = continue_on_error.unwrap_or(false);
    // Câu lệnh lỗi đã bỏ qua: đếm hết, nhưng chỉ giữ vài cái đầu để hiện cho người dùng.
    let mut failed_count: usize = 0;
    let mut failed_samples: Vec<Value> = Vec::new();
    const FAILED_SAMPLES_MAX: usize = 5;
    // Restore acquires its own connection and runs its own transaction. It would not corrupt the
    // user's open transaction — different session — but it would block on the locks that
    // transaction holds, and a frozen progress bar is a worse answer than a clear refusal.
    crate::tx_session::reject_if_manual_or_open(&conn_id, "phục hồi dữ liệu")?;
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };
    // Restore replays a whole dump on its own connection, so none of the funnels sees it.
    reject_conn_read_only(&conn_type)?;

    let mut statements_count = 0;
    let mut last_use_db: Option<String> = None;

    // Dùng CHUNG splitter với SQL editor: nó hiểu lệnh DELIMITER của MySQL và khối $$ của
    // Postgres, nên thân trigger/procedure/function không bị cắt ở dấu ';' bên trong.
    let statements = split_sql_statements(&sql_content);

    // Lọc TRƯỚC để biết tổng số câu lệnh sẽ chạy -> báo được phần trăm thật thay vì thanh vô định.
    // bool đi kèm = lệnh cấp phiên/schema (lỗi của nó không huỷ cả lần restore).
    let mut to_run: Vec<(String, bool)> = Vec::new();
    let matcher = TableMatcher::new(&tables);
    for q in statements {
        // Phân loại theo phần SAU comment đầu câu: dump của mysqldump luôn có
        // `-- Dumping data for table x` dán liền trước LOCK TABLES / INSERT.
        let body = strip_leading_comments(&q);
        let head = upper_head(body);
        if is_skipped_stmt(&head) {
            continue;
        }
        if body.is_empty() {
            // Câu chỉ còn comment. Comment ĐIỀU KIỆN của MySQL (`/*!40101 SET NAMES utf8mb4 */`)
            // là lệnh thật và ảnh hưởng tới charset/timezone của dữ liệu nhập -> vẫn phải chạy
            // (xếp vào cấp phiên để lỗi không huỷ cả lần restore). Comment thường thì bỏ.
            if q.contains("/*!") {
                to_run.push((q, true));
            }
            continue;
        }
        let session_level = is_session_level_stmt(&head);
        if session_level {
            if head.starts_with("USE ") {
                if let Some(db) = use_db_name(body) {
                    last_use_db = Some(db);
                }
            }
        } else if !matcher.matches(&q) {
            continue;
        }
        to_run.push((q, session_level));
    }

    // Đẩy mọi câu CREATE VIEW xuống cuối.
    //
    // Dump ghi view xen kẽ với bảng theo thứ tự alphabet — view `actor_info` của sakila đứng
    // ngay sau bảng `actor`, trước cả bảng `film` mà nó đọc — trong khi `CREATE VIEW` được
    // kiểm tra NGAY lúc chạy: MySQL trả 1146 "Table doesn't exist" và cả lần nhập bị rollback.
    // Bên xuất đã được sửa để ghi view sau bảng, nhưng những tệp dump đã có sẵn (và dump của
    // công cụ khác) thì không sửa được nữa, nên chỗ chạy cũng phải chịu được thứ tự sai.
    //
    // Chỉ CREATE VIEW được dời, và thứ tự tương đối giữa chúng được giữ nguyên (một view có thể
    // đọc view khác; export của app xếp sẵn theo phụ thuộc — xem `orderViewsByDependency`).
    // `DROP VIEW` nằm lại chỗ cũ là vô hại. Dời thêm loại câu lệnh khác thì có thể đổi nghĩa
    // của dump — ví dụ dump nào INSERT qua một updatable view sẽ hỏng.
    if let Ok(create_view_re) = regex::Regex::new(
        r"(?i)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?VIEW\b",
    ) {
        // partition giữ nguyên thứ tự trong từng nhóm.
        let (rest, views): (Vec<_>, Vec<_>) = to_run
            .into_iter()
            .partition(|(q, _)| !create_view_re.is_match(strip_leading_comments(q)));
        to_run = rest;
        to_run.extend(views);
    }

    let total = to_run.len();
    let _ = on_progress.send(json!({ "type": "start", "total": total }));
    // Gửi mỗi PROGRESS_EVERY câu để không làm ngập IPC với dump hàng chục nghìn câu lệnh.
    const PROGRESS_EVERY: usize = 20;
    let send_progress = |done: usize| {
        let _ = on_progress.send(json!({ "type": "progress", "done": done, "total": total }));
    };


    match &conn_type.kind {
        DbKind::Mysql(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;

            // 0. Dọn khoá còn treo trên connection này. LOCK TABLES là theo SESSION và pool thì
            //    tái dùng session: một lần restore trước đó chạy `LOCK TABLES x WRITE` mà không
            //    tới được `UNLOCK TABLES` sẽ để khoá lại, khiến lần sau ghi bảng khác báo lỗi
            //    1100 "was not locked with LOCK TABLES". Phải đứng TRƯỚC START TRANSACTION vì
            //    UNLOCK TABLES tự commit transaction đang mở.
            let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;

            // 1. Tắt khóa ngoại
            let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 0;").execute(&mut *conn).await;
            // 2. Bắt đầu Transaction
            let _ = sqlx::query("START TRANSACTION;").execute(&mut *conn).await;

            // 3. Chạy các lệnh
            for (idx, (q, session_level)) in to_run.iter().enumerate() {
                let session_level = *session_level;

                // raw_sql = text protocol: MySQL KHÔNG cho CREATE/DROP TRIGGER|PROCEDURE|FUNCTION|
                // EVENT chạy qua prepared statement (lỗi 1295), mà dump thường có đủ mấy loại này.
                // Restore chỉ cần chạy, không đọc dòng nào, nên dùng text protocol cho tất cả.
                if let Err(e) = sqlx::raw_sql(sqlx::AssertSqlSafe(q.clone())).execute(&mut *conn).await {
                    // Lệnh cấp phiên/schema lỗi thì bỏ qua; lỗi thật thì Rollback rồi trả lỗi.
                    if !session_level {
                        if continue_on_error {
                            // Lỗi một câu KHÔNG huỷ transaction của MySQL, nên phần đã ghi vẫn
                            // còn và chạy tiếp được ngay.
                            failed_count += 1;
                            if failed_samples.len() < FAILED_SAMPLES_MAX {
                                failed_samples.push(json!({ "sql": stmt_for_error(q), "error": e.to_string() }));
                            }
                            continue;
                        }
                        let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
                        // Trả connection về pool ở trạng thái sạch, không để khoá/FK-check treo lại.
                        let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;
                        let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
                        return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", stmt_for_error(q), e));
                    }
                    continue;
                }
                statements_count += 1;
                if idx % PROGRESS_EVERY == 0 || idx + 1 == total {
                    send_progress(idx + 1);
                }

            }

            let _ = sqlx::query("COMMIT;").execute(&mut *conn).await;
            // 4. Trả connection về pool sạch sẽ: bỏ khoá (nếu dump có LOCK lọt qua) + bật lại FK
            let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;
            let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
        }
        _ => {
            // Tắt kiểm tra khóa ngoại và bắt đầu Transaction
            match &conn_type.kind {
                DbKind::Postgres(_) => {
                    let _ = execute_raw_sql_generic(&conn_type, "SET CONSTRAINTS ALL DEFERRED;".to_string()).await;
                    let _ = execute_raw_sql_generic(&conn_type, "BEGIN;".to_string()).await;
                }
                DbKind::Sqlite(conn_arc) => {
                    if let Ok(conn) = conn_arc.lock() {
                        let _ = conn.execute("PRAGMA foreign_keys = OFF;", []);
                        let _ = conn.execute("BEGIN TRANSACTION;", []);
                    }
                }
                _ => {}
            }

            for (idx, (q, session_level)) in to_run.iter().enumerate() {
                let session_level = *session_level;

                let exec_sql = match &conn_type.kind {
                    DbKind::Postgres(_) => q.replace("`", "\""),
                    _ => q.clone(),
                };
                // Postgres: một lỗi làm cả transaction chuyển sang trạng thái aborted (25P02),
                // mọi câu sau đó đều lỗi "current transaction is aborted". Muốn chạy tiếp thì
                // phải có điểm lùi cho từng câu. Chỉ trả giá 2 round trip khi người dùng bật
                // chế độ này; MySQL và SQLite không cần vì lỗi một câu không huỷ transaction.
                let pg_savepoint = continue_on_error && matches!(&conn_type.kind, DbKind::Postgres(_));
                if pg_savepoint {
                    let _ = execute_raw_sql_generic(&conn_type, "SAVEPOINT tn_restore_sp;".to_string()).await;
                }
                if let Err(e) = execute_raw_sql_generic(&conn_type, exec_sql).await {
                    if !session_level && continue_on_error {
                        if pg_savepoint {
                            let _ = execute_raw_sql_generic(&conn_type, "ROLLBACK TO SAVEPOINT tn_restore_sp;".to_string()).await;
                        }
                        failed_count += 1;
                        if failed_samples.len() < FAILED_SAMPLES_MAX {
                            failed_samples.push(json!({ "sql": stmt_for_error(q), "error": e.to_string() }));
                        }
                        continue;
                    }
                    if !session_level {
                        // Rollback nếu có lỗi
                        match &conn_type.kind {
                            DbKind::Postgres(_) => {
                                let _ = execute_raw_sql_generic(&conn_type, "ROLLBACK;".to_string()).await;
                            }
                            DbKind::Sqlite(conn_arc) => {
                                if let Ok(conn) = conn_arc.lock() {
                                    let _ = conn.execute("ROLLBACK;", []);
                                    let _ = conn.execute("PRAGMA foreign_keys = ON;", []);
                                }
                            }
                            _ => {}
                        }
                        return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", stmt_for_error(q), e));
                    }
                    continue;
                }
                // Giải phóng điểm lùi ngay khi câu chạy xong, không để savepoint dồn lại.
                if pg_savepoint {
                    let _ = execute_raw_sql_generic(&conn_type, "RELEASE SAVEPOINT tn_restore_sp;".to_string()).await;
                }
                statements_count += 1;
                if idx % PROGRESS_EVERY == 0 || idx + 1 == total {
                    send_progress(idx + 1);
                }

            }

            // Commit transaction
            match &conn_type.kind {
                DbKind::Postgres(_) => {
                    let _ = execute_raw_sql_generic(&conn_type, "COMMIT;".to_string()).await;
                }
                DbKind::Sqlite(conn_arc) => {
                    if let Ok(conn) = conn_arc.lock() {
                        let _ = conn.execute("COMMIT;", []);
                    }
                }
                _ => {}
            }

            // Bật lại khóa ngoại
            match &conn_type.kind {
                DbKind::Sqlite(conn_arc) => {
                    if let Ok(conn) = conn_arc.lock() {
                        let _ = conn.execute("PRAGMA foreign_keys = ON;", []);
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(ref db_name) = last_use_db {
        let (last_conf_opt, db_type, tunnel_port) = {
            // Server-level, không phải connection-level: `last_config` + cổng tunnel thuộc
            // `ServerHandle`. `last_config` ở đó là `Value` (một server thì luôn có config) nên bọc
            // `Some` để phần dưới không phải đổi.
            let ctx = state.connections.acquire(&conn_id)?;
            (Some(ctx.server().config()), ctx.server().db_type.clone(),
             ctx.server().ssh_tunnel.as_ref().map(|t| t.local_port))
        };

        if let Some(mut last_conf) = last_conf_opt {
            if let Some(obj) = last_conf.as_object_mut() {
                obj.insert("database".to_string(), json!(db_name));
                // Nếu đang dùng SSH tunnel, reconnect vẫn phải đi qua 127.0.0.1:<local_port>
                if let Some(port) = tunnel_port {
                    obj.insert("host".to_string(), json!("127.0.0.1"));
                    obj.insert("port".to_string(), json!(port));
                }
            }

            let new_conn = match db_type.as_str() {
                "postgres" => {
                    let url = build_pg_url(&last_conf, Some(db_name.as_str()));
                    let pool = PgPool::connect(&url).await.map_err(|e| e.to_string())?;
                    Some(DbKind::Postgres(pool))
                }
                "mysql" => {
                    let url = build_mysql_url(&last_conf, Some(db_name.as_str()));
                    let pool = MySqlPool::connect(&url).await.map_err(|e| e.to_string())?;
                    Some(DbKind::Mysql(pool))
                }
                _ => None
            };
            if let Some(kind) = new_conn {
                // `USE <db>` đổi database ngay dưới chân tab đang restore. Phase 3 sẽ mint một
                // `conn_id` mới cho database mới (§4.3); ở đây vẫn chuyển entry hiện tại như trước —
                // nên pool mới mang ĐÚNG id của entry đó, không phải một id mới.
                let ctx = state.connections.acquire(&conn_id)?;
                let id = ctx.id().clone();
                ctx.server().set_config(last_conf);
                state.connections.replace_conn(&id, DbConnection::session(id.clone(), kind))?;
                state.connections.set_db(&id, db_name.clone())?;
            }
        }
    }

    let _ = on_progress.send(json!({ "type": "done", "done": total, "total": total, "statementsCount": statements_count }));

    Ok(json!({
        "success": true,
        "statementsCount": statements_count,
        "activeDatabase": last_use_db,
        // Chỉ khác 0 khi bật continue_on_error — UI phải nói rõ "đã nhập nhưng thiếu ngần này",
        // im lặng ở đây thì người dùng tin là nhập trọn vẹn.
        "failedCount": failed_count,
        "failedSamples": failed_samples
    }))
}
