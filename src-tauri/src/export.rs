use serde_json::Value;
use std::fs::File;
use std::io::Write;
use flate2::write::GzEncoder;
use flate2::Compression;

pub fn export_to_csv(columns: &[String], rows: &[Value], file_path: &str) -> Result<(), String> {
    let mut file = File::create(file_path).map_err(|e| e.to_string())?;
    
    // Write headers
    let header = columns.join(",") + "\n";
    file.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    
    // Write rows
    for row in rows {
        if let Some(obj) = row.as_object() {
            let mut row_vals = Vec::new();
            for col in columns {
                let val_str = match obj.get(col) {
                    Some(Value::Null) => String::new(),
                    Some(Value::String(s)) => format!("\"{}\"", s.replace("\"", "\"\"")),
                    Some(other) => other.to_string(),
                    None => String::new(),
                };
                row_vals.push(val_str);
            }
            let line = row_vals.join(",") + "\n";
            file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    
    Ok(())
}

pub fn export_to_json(rows: &[Value], file_path: &str) -> Result<(), String> {
    let mut file = File::create(file_path).map_err(|e| e.to_string())?;
    let json_str = serde_json::to_string_pretty(rows).map_err(|e| e.to_string())?;
    file.write_all(json_str.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn export_to_sql(table_name: &str, columns: &[String], rows: &[Value], file_path: &str) -> Result<(), String> {
    let mut file = File::create(file_path).map_err(|e| e.to_string())?;
    
    for row in rows {
        if let Some(obj) = row.as_object() {
            let mut val_strings = Vec::new();
            for col in columns {
                let val_str = match obj.get(col) {
                    Some(Value::Null) => "NULL".to_string(),
                    Some(Value::String(s)) => format!("'{}'", s.replace("'", "''")),
                    Some(other) => other.to_string(),
                    None => "NULL".to_string(),
                };
                val_strings.push(val_str);
            }
            
            let col_list = columns.iter().map(|c| format!("\"{}\"", c)).collect::<Vec<_>>().join(", ");
            let val_list = val_strings.join(", ");
            let sql = format!("INSERT INTO \"{}\" ({}) VALUES ({});\n", table_name, col_list, val_list);
            file.write_all(sql.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    
    Ok(())
}

pub fn gzip_file(source_path: &str, dest_path: &str) -> Result<(), String> {
    let mut input = File::open(source_path).map_err(|e| e.to_string())?;
    let output = File::create(dest_path).map_err(|e| e.to_string())?;
    let mut encoder = GzEncoder::new(output, Compression::default());
    std::io::copy(&mut input, &mut encoder).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())?;
    Ok(())
}
