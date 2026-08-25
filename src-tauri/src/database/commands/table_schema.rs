//! `get_table_schema` — the columns / indexes / foreign keys of ONE table, for the structure editor.

use serde_json::{json, Value};
use sqlx::Row;

use crate::database::{pg_schema_of, sql_str, DbKind};

use super::catalog::get_primary_key_columns;

#[tauri::command]
pub async fn get_table_schema(state: tauri::State<'_, crate::AppState>, conn_id: String, name: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };
    let sch = sql_str(&pg_schema_of(&schema));

    let mut indexes = Vec::new();
    let mut foreign_keys = Vec::new();
    let mut columns = Vec::new();

    // The real list of primary-key columns (used for Postgres/MySQL; SQLite takes it straight from the PRAGMA)
    let pk_cols = get_primary_key_columns(&conn_type, &schema, &name).await;

    match &conn_type.kind {
        DbKind::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let sql = format!("PRAGMA table_info(\"{}\")", name);
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let col_name: String = row.get("name").map_err(|e| e.to_string())?;
                let col_type: String = row.get("type").map_err(|e| e.to_string())?;
                let notnull: i32 = row.get("notnull").map_err(|e| e.to_string())?;
                let pk: i32 = row.get("pk").map_err(|e| e.to_string())?;
                let def_val: Option<String> = row.get("dflt_value").map_err(|e| e.to_string())?;
                
                columns.push(json!({
                    "name": col_name,
                    "type": col_type,
                    "nullable": notnull == 0,
                    "isPrimaryKey": pk > 0,
                    "defaultValue": def_val,
                    "autoIncrement": pk > 0 && col_type.to_uppercase() == "INTEGER"
                }));
            }

            // The list of SQLite indexes
            let idx_sql = format!("PRAGMA index_list(\"{}\")", name);
            let mut idx_stmt = conn.prepare(&idx_sql).map_err(|e| e.to_string())?;
            let mut idx_rows = idx_stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = idx_rows.next().map_err(|e| e.to_string())? {
                let idx_name: String = row.get("name").map_err(|e| e.to_string())?;
                let unique: bool = row.get::<_, i32>("unique").map_err(|e| e.to_string())? == 1;

                // The columns belonging to this index
                let info_sql = format!("PRAGMA index_info(\"{}\")", idx_name);
                let mut info_stmt = conn.prepare(&info_sql).map_err(|e| e.to_string())?;
                let mut info_rows = info_stmt.query([]).map_err(|e| e.to_string())?;
                let mut cols_in_idx = Vec::new();
                while let Some(i_row) = info_rows.next().map_err(|e| e.to_string())? {
                    let col_name: String = i_row.get("name").map_err(|e| e.to_string())?;
                    cols_in_idx.push(col_name);
                }

                indexes.push(json!({
                    "name": idx_name,
                    "columns": cols_in_idx.join(", "),
                    "unique": unique,
                    "type": if unique { "UNIQUE" } else { "INDEX" },
                    "method": "BTREE"
                }));
            }

            // The list of SQLite foreign keys
            let fk_sql = format!("PRAGMA foreign_key_list(\"{}\")", name);
            let mut fk_stmt = conn.prepare(&fk_sql).map_err(|e| e.to_string())?;
            let mut fk_rows = fk_stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = fk_rows.next().map_err(|e| e.to_string())? {
                let from_col: String = row.get("from").map_err(|e| e.to_string())?;
                let to_table: String = row.get("table").map_err(|e| e.to_string())?;
                let to_col: String = row.get("to").map_err(|e| e.to_string())?;
                let id: i32 = row.get("id").map_err(|e| e.to_string())?;
                foreign_keys.push(json!({
                    "name": format!("fk_{}_{}_{}", name, from_col, id),
                    "column": from_col,
                    "refTable": to_table,
                    "refColumn": to_col
                }));
            }
        }
        DbKind::Postgres(pool) => {
            // format_type() instead of information_schema.data_type: the latter drops
            // length/precision (`character varying`, `numeric`) so the structure editor
            // could neither show `varchar(45)` nor round-trip it into ALTER TABLE.
            // Two different things, and a dump has to treat them differently:
            //   attgenerated <> ''  = GENERATED ALWAYS AS (...) STORED — a computed column.
            //     Postgres refuses any write to it, so it must be left OUT of the INSERT.
            //   attidentity = 'a'   = GENERATED ALWAYS AS IDENTITY. It stays IN the INSERT
            //     (dropping it would renumber the rows and break every foreign key pointing
            //     at them), but the statement then needs OVERRIDING SYSTEM VALUE.
            //     attidentity = 'd' (BY DEFAULT) accepts a plain INSERT.
            let sql = format!(
                "SELECT a.attname::text AS column_name,
                        format_type(a.atttypid, a.atttypmod) AS data_type,
                        CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
                        pg_get_expr(d.adbin, d.adrelid) AS column_default,
                        a.attgenerated <> '' AS is_generated,
                        a.attidentity = 'a' AS is_identity_always
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE n.nspname = '{}' AND c.relname = '{}'
                   AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum", sch, name.replace('\'', "''")
            );
            let rows = sqlx::query(sqlx::AssertSqlSafe(sql.clone())).fetch_all(pool).await.map_err(|e| e.to_string())?;
            for r in rows {
                let col_name: String = r.get("column_name");
                let col_type: String = r.get("data_type");
                let is_nullable: String = r.get("is_nullable");
                let column_default: Option<String> = r.try_get("column_default").ok();
                let is_generated: bool = r.try_get("is_generated").unwrap_or(false);
                let is_identity_always: bool = r.try_get("is_identity_always").unwrap_or(false);
                let is_pk = pk_cols.iter().any(|c| c == &col_name);

                columns.push(json!({
                    "name": col_name,
                    "type": col_type,
                    "nullable": is_nullable == "YES",
                    "isPrimaryKey": is_pk,
                    "defaultValue": column_default,
                    "autoIncrement": column_default.as_ref().map(|d| d.contains("nextval")).unwrap_or(false),
                    "extra": serde_json::Value::Null,
                    "generated": is_generated,
                    "identityAlways": is_identity_always
                }));
            }

            // The list of Postgres indexes
            let idx_sql = format!(
                "SELECT i.relname AS index_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary, am.amname AS index_method, pg_get_indexdef(ix.indexrelid) AS index_def
                 FROM pg_class t
                 JOIN pg_index ix ON t.oid = ix.indrelid
                 JOIN pg_class i ON i.oid = ix.indexrelid
                 JOIN pg_am am ON i.relam = am.oid
                 JOIN pg_namespace n ON n.oid = t.relnamespace
                 WHERE t.relkind = 'r' AND n.nspname = '{}' AND t.relname = '{}'",
                sch, name.replace('\'', "''")
            );
            if let Ok(idx_rows) = sqlx::query(sqlx::AssertSqlSafe(idx_sql)).fetch_all(pool).await {
                for r in idx_rows {
                    let idx_name: String = r.get(0);
                    let unique: bool = r.get(1);
                    let is_primary: bool = r.get(2);
                    let method: String = r.get(3);
                    let index_def: String = r.get(4);
                    
                    let columns_str = if let Some(start) = index_def.rfind('(') {
                        if let Some(end) = index_def.rfind(')') {
                            index_def[start + 1..end].to_string()
                        } else {
                            "".to_string()
                        }
                    } else {
                        "".to_string()
                    };

                    indexes.push(json!({
                        "name": idx_name,
                        "columns": columns_str,
                        "unique": unique || is_primary,
                        "type": if is_primary { "PRIMARY" } else if unique { "UNIQUE" } else { "INDEX" },
                        "method": method.to_uppercase()
                    }));
                }
            }

            // The list of Postgres foreign keys
            let fk_sql = format!(
                "SELECT tc.constraint_name AS name, kcu.column_name AS column, ccu.table_name AS ref_table, ccu.column_name AS ref_column
                 FROM information_schema.table_constraints AS tc
                 JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                 JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
                 WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '{}' AND tc.table_name = '{}'",
                sch, name.replace('\'', "''")
            );
            if let Ok(fk_rows) = sqlx::query(sqlx::AssertSqlSafe(fk_sql)).fetch_all(pool).await {
                for r in fk_rows {
                    let fk_name: String = r.get("name");
                    let from_col: String = r.get("column");
                    let to_table: String = r.get("ref_table");
                    let to_col: String = r.get("ref_column");
                    foreign_keys.push(json!({
                        "name": fk_name,
                        "column": from_col,
                        "refTable": to_table,
                        "refColumn": to_col
                    }));
                }
            }
        }
        DbKind::Mysql(pool) => {
            // COLUMN_TYPE, not DATA_TYPE: the former carries length/precision and the
            // unsigned/zerofill flags (`varchar(45)`, `int(10) unsigned`, `enum('a','b')`),
            // which the structure editor both displays and feeds back into MODIFY COLUMN.
            let sql = format!(
                "SELECT column_name, column_type, is_nullable, column_default, extra, character_set_name, collation_name
                 FROM information_schema.columns
                 WHERE table_name = '{}' AND table_schema = DATABASE()
                 ORDER BY ordinal_position", name
            );
            let rows = sqlx::query(sqlx::AssertSqlSafe(sql.clone())).fetch_all(pool).await.map_err(|e| e.to_string())?;
            for r in rows {
                let col_name: String = r.get(0);
                let col_type: String = r.get(1);
                let is_nullable: String = r.get(2);
                let column_default: Option<String> = r.try_get(3).ok();
                let extra: String = r.get(4);
                let char_set: Option<String> = r.try_get(5).ok();
                let collation: Option<String> = r.try_get(6).ok();
                let is_pk = pk_cols.iter().any(|c| c == &col_name);

                columns.push(json!({
                    "name": col_name,
                    "type": col_type,
                    "nullable": is_nullable == "YES",
                    "isPrimaryKey": is_pk,
                    "defaultValue": column_default,
                    "autoIncrement": extra.contains("auto_increment"),
                    "extra": if extra.trim().is_empty() { serde_json::Value::Null } else { serde_json::Value::String(extra.clone()) },
                    // EXTRA reads "VIRTUAL GENERATED" / "STORED GENERATED". Writing such a
                    // column is MySQL error 3105, so a dump must leave it out of the INSERT.
                    "generated": extra.to_uppercase().contains("GENERATED"),
                    "characterSet": char_set,
                    "collation": collation
                }));
            }

            // The list of MySQL indexes
            let idx_sql = format!("SHOW INDEX FROM `{}`", name);
            if let Ok(idx_rows) = sqlx::query(sqlx::AssertSqlSafe(idx_sql)).fetch_all(pool).await {
                use std::collections::HashMap;
                let mut idx_map: HashMap<String, (Vec<String>, bool, String)> = HashMap::new();
                for r in idx_rows {
                    let key_name: String = r.try_get("Key_name").or_else(|_| r.try_get("KEY_NAME")).unwrap_or_default();
                    let col_name: String = r.try_get("Column_name").or_else(|_| r.try_get("COLUMN_NAME")).unwrap_or_default();
                    let non_unique: i64 = r.try_get::<i64, _>("Non_unique")
                        .or_else(|_| r.try_get::<i64, _>("NON_UNIQUE"))
                        .or_else(|_| r.try_get::<i32, _>("Non_unique").map(|v| v as i64))
                        .or_else(|_| r.try_get::<i32, _>("NON_UNIQUE").map(|v| v as i64))
                        .unwrap_or(1);
                    let index_type: String = r.try_get("Index_type")
                        .or_else(|_| r.try_get("INDEX_TYPE"))
                        .unwrap_or_else(|_| "BTREE".to_string());
                    let entry = idx_map.entry(key_name).or_insert((Vec::new(), non_unique == 0, index_type));
                    entry.0.push(col_name);
                }
                for (idx_name, (cols, unique, method)) in idx_map {
                    let is_primary = idx_name == "PRIMARY";
                    indexes.push(json!({
                        "name": idx_name,
                        "columns": cols.join(", "),
                        "unique": unique || is_primary,
                        "type": if is_primary { "PRIMARY" } else if unique { "UNIQUE" } else { "INDEX" },
                        "method": method.to_uppercase()
                    }));
                }
            }

            // The list of MySQL foreign keys
            let fk_sql = format!(
                "SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS `column`, REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
                 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}' AND REFERENCED_TABLE_NAME IS NOT NULL", name
            );
            if let Ok(fk_rows) = sqlx::query(sqlx::AssertSqlSafe(fk_sql)).fetch_all(pool).await {
                for r in fk_rows {
                    let fk_name: String = r.get(0);
                    let from_col: String = r.get(1);
                    let to_table: String = r.get(2);
                    let to_col: String = r.get(3);
                    foreign_keys.push(json!({
                        "name": fk_name,
                        "column": from_col,
                        "refTable": to_table,
                        "refColumn": to_col
                    }));
                }
            }
        }
    }
    
    Ok(json!({
        "success": true,
        "columns": columns,
        "indexes": indexes,
        "foreignKeys": foreign_keys
    }))
}
