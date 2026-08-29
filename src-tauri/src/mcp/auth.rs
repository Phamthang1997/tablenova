//! The bearer token (defence layer 2): minted here, kept in the OS keyring, compared in constant time.

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::credentials::secret_store::{secret_get, secret_set};

/// Where the token sits in the keyring. The store was built for connection profiles and is keyed by
/// `(profile_id, field)`; the MCP token is not a profile, so it takes a name no profile id can
/// collide with — real profile ids are UUIDs.
const PROFILE: &str = "__mcp__";
const FIELD: &str = "token";

/// 256 bits from the OS CSPRNG.
///
/// `uuid` is already in the tree with `v4` enabled (it mints `conn_id`), so this needs no new
/// dependency, and two v4 values carry the same entropy as a 32-byte random string.
fn mint() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// The current token, minting and storing one on first use.
pub fn load_or_create() -> Result<String, String> {
    if let Some(existing) = secret_get(PROFILE.to_string(), FIELD.to_string())?
        && !existing.is_empty()
    {
        return Ok(existing);
    }
    regenerate()
}

/// Mints a new token and forgets the old one.
///
/// Every client configured with the previous token stops working at its next request — that is the
/// point of the button, and the UI has to say so before calling this.
pub fn regenerate() -> Result<String, String> {
    let token = mint();
    secret_set(PROFILE.to_string(), FIELD.to_string(), token.clone())?;
    Ok(token)
}

/// Does the presented token match the expected one?
///
/// `expected` is the token the server read from the keyring **once, at startup** — deliberately not
/// re-read here. This runs on every request, and a keyring lookup is a syscall into Windows
/// Credential Manager / Keychain; putting it on the hot path buys nothing, since a token changed
/// behind the server's back only takes effect on restart anyway (regenerating restarts it).
///
/// Both sides are hashed first so the comparison always runs over 32 fixed-length bytes: a plain
/// `==` on the strings returns early at the first differing byte, which leaks the length and the
/// matching prefix through timing.
pub fn verify(presented: &str, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    ct_eq(&digest(presented), &digest(expected))
}

fn digest(s: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().into()
}

fn ct_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_tokens_are_long_and_distinct() {
        let a = mint();
        let b = mint();
        assert_eq!(a.len(), 64, "two simple-form UUIDs are 32 hex chars each");
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn verify_accepts_only_the_exact_token() {
        assert!(verify("abc", "abc"));
        assert!(!verify("abc", "abd"));
        // Same length, differing only in the last byte: the case an early-exit compare answers
        // fastest and therefore leaks the most.
        assert!(!verify("token-aaaa", "token-aaab"));
    }

    #[test]
    fn empty_expected_never_matches() {
        // A keyring that returned nothing must not turn into "any token is fine", including "".
        assert!(!verify("", ""));
        assert!(!verify("anything", ""));
    }
}
