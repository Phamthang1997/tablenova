// Kho bí mật cho profile kết nối: mật khẩu DB, mật khẩu/passphrase/private key SSH,
// AWS secret key... được cất trong kho bảo mật của HĐH thay vì localStorage.
//
// Lý do: localStorage của webview nằm trên đĩa dưới dạng file thường (Windows:
// EBWebView\Default\Local Storage\leveldb) và KHÔNG mã hoá — tiến trình nào chạy dưới
// cùng user cũng đọc được mật khẩu DB lẫn private key SSH. CodeQL cảnh báo đúng ở
// js/clear-text-storage-of-sensitive-data.
//
// Frontend chỉ còn lưu phần cấu hình không nhạy cảm; mỗi bí mật là một mục riêng trong
// kho HĐH, định danh bằng "<profile_id>:<tên_field>".

use keyring::Entry;
use serde::{Deserialize, Serialize};

// Tên service hiển thị trong Windows Credential Manager / Keychain.
const SERVICE: &str = "TableNova";

#[derive(Debug, Serialize, Deserialize)]
pub struct SecretRef {
    /// Id profile kết nối (khoá trong localStorage).
    pub profile_id: String,
    /// Tên field bí mật, vd "password", "sshPassphrase".
    pub field: String,
}

impl SecretRef {
    // Khoá tài khoản trong kho: gộp profile + field để mỗi bí mật là một mục riêng.
    // Tách từng mục thay vì gói chung một JSON để không đụng giới hạn kích thước của
    // Windows Credential Manager (2560 byte mỗi mục) khi có private key dài.
    fn account(&self) -> String {
        format!("{}:{}", self.profile_id, self.field)
    }

    fn entry(&self) -> Result<Entry, String> {
        Entry::new(SERVICE, &self.account())
            .map_err(|e| format!("Không mở được kho bí mật của hệ điều hành: {}", e))
    }
}

/// Ghi một bí mật vào kho HĐH. Giá trị rỗng đồng nghĩa với xoá.
#[tauri::command]
pub fn secret_set(profile_id: String, field: String, value: String) -> Result<(), String> {
    let r = SecretRef { profile_id, field };
    if value.is_empty() {
        return secret_delete(r.profile_id, r.field);
    }
    r.entry()?.set_password(&value).map_err(|e| {
        format!(
            "Không lưu được '{}' vào kho bí mật: {}. Bí mật quá dài (private key lớn) có thể vượt giới hạn của kho HĐH.",
            r.field, e
        )
    })
}

/// Đọc một bí mật. Trả về None nếu chưa từng lưu.
#[tauri::command]
pub fn secret_get(profile_id: String, field: String) -> Result<Option<String>, String> {
    let r = SecretRef { profile_id, field };
    match r.entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Không đọc được '{}' từ kho bí mật: {}", r.field, e)),
    }
}

/// Xoá một bí mật. Không có sẵn cũng coi như thành công.
#[tauri::command]
pub fn secret_delete(profile_id: String, field: String) -> Result<(), String> {
    let r = SecretRef { profile_id, field };
    match r.entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Không xoá được '{}' khỏi kho bí mật: {}", r.field, e)),
    }
}

/// Đọc nhiều bí mật của một profile trong một lần gọi (dùng khi nạp form / lúc kết nối).
/// Field nào chưa có thì không xuất hiện trong map trả về.
#[tauri::command]
pub fn secret_get_many(
    profile_id: String,
    fields: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let mut out = std::collections::HashMap::new();
    for field in fields {
        if let Some(v) = secret_get(profile_id.clone(), field.clone())? {
            out.insert(field, v);
        }
    }
    Ok(out)
}

/// Ghi nhiều bí mật của một profile trong một lần gọi (dùng khi lưu profile / migrate).
#[tauri::command]
pub fn secret_set_many(
    profile_id: String,
    values: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    for (field, value) in values {
        secret_set(profile_id.clone(), field, value)?;
    }
    Ok(())
}

/// Xoá toàn bộ bí mật của một profile (khi xoá profile đó).
#[tauri::command]
pub fn secret_delete_many(profile_id: String, fields: Vec<String>) -> Result<(), String> {
    for field in fields {
        secret_delete(profile_id.clone(), field)?;
    }
    Ok(())
}
