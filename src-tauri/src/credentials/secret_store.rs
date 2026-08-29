// The secret store for connection profiles: DB passwords, SSH password/passphrase/private key,
// AWS secret key... kept in the OS credential store instead of localStorage.
//
// Why: the webview's localStorage sits on disk as ordinary files (Windows:
// EBWebView\Default\Local Storage\leveldb) and is NOT encrypted — any process running as the
// same user can read both DB passwords and SSH private keys. CodeQL is right to flag
// js/clear-text-storage-of-sensitive-data.
//
// The frontend only stores the non-sensitive part of the config; each secret is its own entry in
// the OS store, identified by "<profile_id>:<field_name>".

use keyring::Entry;
use serde::{Deserialize, Serialize};

// The service name shown in Windows Credential Manager / Keychain.
const SERVICE: &str = "TableNova";

#[derive(Debug, Serialize, Deserialize)]
pub struct SecretRef {
    /// Connection profile id (the key in localStorage).
    pub profile_id: String,
    /// Name of the secret field, e.g. "password", "sshPassphrase".
    pub field: String,
}

impl SecretRef {
    // The account key in the store: profile + field combined so each secret is its own entry.
    // Separate entries rather than one bundled JSON so a long private key cannot hit Windows
    // Credential Manager's size limit (2560 bytes per entry).
    fn account(&self) -> String {
        format!("{}:{}", self.profile_id, self.field)
    }

    fn entry(&self) -> Result<Entry, String> {
        Entry::new(SERVICE, &self.account())
            .map_err(|e| format!("Không mở được kho bí mật của hệ điều hành: {}", e))
    }
}

/// Write one secret into the OS store. An empty value means delete.
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

/// Read one secret. Returns None when nothing was ever stored.
#[tauri::command]
pub fn secret_get(profile_id: String, field: String) -> Result<Option<String>, String> {
    let r = SecretRef { profile_id, field };
    match r.entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Không đọc được '{}' từ kho bí mật: {}", r.field, e)),
    }
}

/// Delete one secret. Not being there counts as success.
#[tauri::command]
pub fn secret_delete(profile_id: String, field: String) -> Result<(), String> {
    let r = SecretRef { profile_id, field };
    match r.entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Không xoá được '{}' khỏi kho bí mật: {}", r.field, e)),
    }
}

/// Read several secrets of one profile in a single call (used when loading the form / when connecting).
/// A field that does not exist simply does not appear in the returned map.
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

/// Write several secrets of one profile in a single call (used when saving a profile / migrating).
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

/// Delete every secret of one profile (when that profile is deleted).
#[tauri::command]
pub fn secret_delete_many(profile_id: String, fields: Vec<String>) -> Result<(), String> {
    for field in fields {
        secret_delete(profile_id.clone(), field)?;
    }
    Ok(())
}
