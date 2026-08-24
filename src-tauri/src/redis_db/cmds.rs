// Pure helpers for the Redis CLI console: tokenizing a typed command line and classifying
// the result. No `tauri`/`redis` imports on purpose — this module is verified with the
// standalone-`rustc` trick described in CLAUDE.md (`redis_cmds_check.rs`), and it is the
// security boundary for read-only mode, so it must be testable without a running app.
//
// WHY CLASSIFICATION LIVES HERE AND NOT IN THE UI
// `RedisBrowser`'s `blockedByReadOnly()` guards every button, but the CLI console used to
// call `redis_execute_cmd` directly, so read-only mode could be bypassed by typing
// `FLUSHALL`. A gate in the WebView is a gate on the wrong side of the IPC boundary.
//
// WHY A WHITELIST
// A blacklist of write commands cannot be kept correct: it silently misses module commands
// (`JSON.SET`, `FT.DROPINDEX`, `TS.ADD`) and every command a future server version adds.
// Anything not listed below is therefore treated as a write and refused in read-only mode.

/// Commands that only read, and whose first token is enough to decide.
const RO_SIMPLE: &[&str] = &[
    // connection / server introspection. DEBUG is deliberately absent: DEBUG SLEEP/SEGFAULT
    // are anything but read-only.
    "PING", "ECHO", "TIME", "LOLWUT", "INFO", "DBSIZE", "LASTSAVE",
    // keyspace. TOUCH is absent too — it updates the key's LRU/LFU metadata.
    "TYPE", "TTL", "PTTL", "EXPIRETIME", "PEXPIRETIME", "EXISTS", "RANDOMKEY", "KEYS", "SCAN",
    "DUMP",
    // string / bitmap
    "GET", "GETRANGE", "SUBSTR", "STRLEN", "MGET", "BITCOUNT", "BITPOS", "GETBIT",
    // hash
    "HGET", "HMGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HSTRLEN", "HEXISTS", "HSCAN",
    "HRANDFIELD", "HTTL", "HPTTL", "HEXPIRETIME", "HPEXPIRETIME",
    // list
    "LRANGE", "LLEN", "LINDEX", "LPOS",
    // set
    "SMEMBERS", "SCARD", "SISMEMBER", "SMISMEMBER", "SRANDMEMBER", "SSCAN", "SINTER", "SUNION",
    "SDIFF", "SINTERCARD",
    // sorted set
    "ZRANGE", "ZRANGEBYSCORE", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZRANGEBYLEX", "ZREVRANGEBYLEX",
    "ZRANK", "ZREVRANK", "ZSCORE", "ZMSCORE", "ZCARD", "ZCOUNT", "ZLEXCOUNT", "ZSCAN",
    "ZRANDMEMBER", "ZDIFF", "ZINTER", "ZUNION", "ZINTERCARD",
    // stream (XAUTOCLAIM/XACK/XADD/XGROUP are writes and deliberately absent)
    "XRANGE", "XREVRANGE", "XLEN",
    // geo (GEOSEARCHSTORE / GEOADD are writes)
    "GEOPOS", "GEODIST", "GEOHASH", "GEOSEARCH",
    // scripting, read-only variants only
    "EVAL_RO", "EVALSHA_RO", "FCALL_RO",
    // RedisJSON reads
    "JSON.GET", "JSON.MGET", "JSON.TYPE", "JSON.STRLEN", "JSON.ARRLEN", "JSON.ARRINDEX",
    "JSON.OBJLEN", "JSON.OBJKEYS", "JSON.RESP", "JSON.DEBUG",
    // RediSearch reads
    "FT.SEARCH", "FT.AGGREGATE", "FT.INFO", "FT._LIST", "FT.EXPLAIN", "FT.EXPLAINCLI",
    "FT.PROFILE", "FT.SPELLCHECK", "FT.TAGVALS", "FT.SUGLEN",
    // TimeSeries reads
    "TS.RANGE", "TS.REVRANGE", "TS.GET", "TS.INFO", "TS.MRANGE", "TS.MREVRANGE", "TS.MGET",
    "TS.QUERYINDEX",
];

/// Container commands where the *subcommand* decides. A bare container with no subcommand
/// is refused: `CONFIG` alone is an error anyway, and defaulting to "allowed" here would
/// mean one typo opens the whole container.
///
/// PFCOUNT is absent from both tables on purpose — Redis flags it as a write because it may
/// rewrite the HyperLogLog's cached cardinality.
const RO_SUB: &[(&str, &[&str])] = &[
    ("CONFIG", &["GET", "HELP"]),
    ("CLIENT", &["LIST", "INFO", "GETNAME", "ID", "NO-TOUCH", "HELP"]),
    ("SLOWLOG", &["GET", "LEN", "HELP"]),
    ("MEMORY", &["USAGE", "STATS", "DOCTOR", "HELP"]),
    ("OBJECT", &["ENCODING", "FREQ", "IDLETIME", "REFCOUNT", "HELP"]),
    ("ACL", &["LIST", "GETUSER", "CAT", "WHOAMI", "USERS", "HELP"]),
    ("CLUSTER", &[
        "INFO", "NODES", "SLOTS", "SHARDS", "MYID", "COUNTKEYSINSLOT", "GETKEYSINSLOT",
        "LINKS", "KEYSLOT", "HELP",
    ]),
    ("FUNCTION", &["LIST", "DUMP", "STATS", "HELP"]),
    // SCRIPT LOAD/FLUSH mutate the server-side script cache, so only EXISTS is read-only.
    ("SCRIPT", &["EXISTS", "HELP"]),
    ("LATENCY", &["HISTORY", "LATEST", "DOCTOR", "GRAPH", "HELP"]),
    ("XINFO", &["STREAM", "GROUPS", "CONSUMERS", "HELP"]),
    ("COMMAND", &["COUNT", "DOCS", "GETKEYS", "GETKEYSANDFLAGS", "INFO", "LIST", "HELP"]),
    ("PUBSUB", &["CHANNELS", "NUMSUB", "NUMPAT", "SHARDCHANNELS", "SHARDNUMSUB", "HELP"]),
];

/// Commands that put a shared connection into a state where no other command can be sent.
/// `MultiplexedConnection` is shared by every Redis feature of the app, so these must never
/// reach it — refused regardless of read-only mode, with the UI pointing at the Pub/Sub or
/// Profiler tab (which each open their own dedicated connection).
const BLOCKING: &[&str] = &[
    "SUBSCRIBE", "UNSUBSCRIBE", "PSUBSCRIBE", "PUNSUBSCRIBE", "SSUBSCRIBE", "SUNSUBSCRIBE",
    "MONITOR", "WAIT", "WAITAOF", "BLPOP", "BRPOP", "BLMOVE", "BRPOPLPUSH", "BLMPOP",
    "BZPOPMIN", "BZPOPMAX", "BZMPOP", "SHUTDOWN", "RESET", "HELLO", "SYNC", "PSYNC",
];

/// Uppercased ASCII view of a token, for comparing against the tables above. Lossy on
/// purpose: a non-UTF-8 command *name* cannot match any entry, which is the safe outcome.
pub fn token_name(token: &[u8]) -> String {
    String::from_utf8_lossy(token).to_ascii_uppercase()
}

/// Splits a typed command line into arguments the way `redis-cli` does.
///
/// Returns bytes, not `String`: a Redis argument may be arbitrary binary (`"\xff\x00"`), and
/// forcing it through UTF-8 would corrupt the value being written. Escapes are honoured
/// inside double quotes (`\n \r \t \b \a \\ \" \xNN`) and, as in `redis-cli`, only `\'` and
/// `\\` inside single quotes.
///
/// An unbalanced quote is a hard error rather than a best-effort split: the classification
/// below reads the first token, so a wrong split is a security decision made on wrong input.
pub fn tokenize(input: &str) -> Result<Vec<Vec<u8>>, String> {
    let bytes = input.as_bytes();
    let mut out: Vec<Vec<u8>> = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut has_token = false;
    let mut i = 0usize;

    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b' ' | b'\t' | b'\r' | b'\n' => {
                if has_token {
                    out.push(std::mem::take(&mut cur));
                    has_token = false;
                }
                i += 1;
            }
            b'"' => {
                has_token = true;
                i += 1;
                loop {
                    if i >= bytes.len() {
                        return Err("Lệnh không hợp lệ: thiếu dấu nháy đóng".to_string());
                    }
                    match bytes[i] {
                        b'"' => {
                            i += 1;
                            break;
                        }
                        b'\\' if i + 1 < bytes.len() => {
                            let e = bytes[i + 1];
                            i += 2;
                            match e {
                                b'n' => cur.push(b'\n'),
                                b'r' => cur.push(b'\r'),
                                b't' => cur.push(b'\t'),
                                b'b' => cur.push(0x08),
                                b'a' => cur.push(0x07),
                                b'x' => {
                                    // \xNN needs both digits; anything else is a literal "x".
                                    let hi = bytes.get(i).copied().and_then(hex_val);
                                    let lo = bytes.get(i + 1).copied().and_then(hex_val);
                                    match (hi, lo) {
                                        (Some(h), Some(l)) => {
                                            cur.push(h * 16 + l);
                                            i += 2;
                                        }
                                        _ => cur.push(b'x'),
                                    }
                                }
                                other => cur.push(other),
                            }
                        }
                        other => {
                            cur.push(other);
                            i += 1;
                        }
                    }
                }
            }
            b'\'' => {
                has_token = true;
                i += 1;
                loop {
                    if i >= bytes.len() {
                        return Err("Lệnh không hợp lệ: thiếu dấu nháy đóng".to_string());
                    }
                    match bytes[i] {
                        b'\'' => {
                            i += 1;
                            break;
                        }
                        b'\\' if i + 1 < bytes.len() && matches!(bytes[i + 1], b'\'' | b'\\') => {
                            cur.push(bytes[i + 1]);
                            i += 2;
                        }
                        other => {
                            cur.push(other);
                            i += 1;
                        }
                    }
                }
            }
            other => {
                cur.push(other);
                has_token = true;
                i += 1;
            }
        }
    }
    if has_token {
        out.push(cur);
    }
    Ok(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// True only for commands known not to modify anything. Unknown commands return **false**
/// (see the whitelist rationale at the top of the file).
pub fn is_read_only_cmd(tokens: &[Vec<u8>]) -> bool {
    let Some(first) = tokens.first() else { return false };
    let cmd = token_name(first);
    if let Some((_, subs)) = RO_SUB.iter().find(|(c, _)| *c == cmd) {
        let Some(sub) = tokens.get(1) else { return false };
        return subs.contains(&token_name(sub).as_str());
    }
    RO_SIMPLE.contains(&cmd.as_str())
}

/// True for commands that would hang or hijack the shared multiplexed connection.
/// `XREAD`/`XREADGROUP` only qualify when they carry `BLOCK`.
pub fn is_blocking_cmd(tokens: &[Vec<u8>]) -> bool {
    let Some(first) = tokens.first() else { return false };
    let cmd = token_name(first);
    if BLOCKING.contains(&cmd.as_str()) {
        return true;
    }
    if cmd == "XREAD" || cmd == "XREADGROUP" {
        return tokens.iter().skip(1).any(|t| token_name(t) == "BLOCK");
    }
    false
}

/// `SELECT n` typed in the console: the connection would switch database while the UI still
/// showed the old index. Detected here so the command can be routed through the same path as
/// the database dropdown instead of being sent blind.
pub fn select_db_arg(tokens: &[Vec<u8>]) -> Option<i64> {
    if tokens.len() != 2 || token_name(&tokens[0]) != "SELECT" {
        return None;
    }
    String::from_utf8_lossy(&tokens[1]).trim().parse::<i64>().ok()
}

/// `redis_version` ("7.4.1", "6.0.16", "255.255.255" on some forks) -> (major, minor).
/// Unparsable input yields (0, 0), which makes every `version_at_least` check fail — i.e.
/// the app falls back to the most compatible code path.
pub fn parse_version(v: &str) -> (u32, u32) {
    let mut it = v.trim().split('.');
    let major = it.next().unwrap_or("").trim().parse().unwrap_or(0);
    let minor = it.next().unwrap_or("").trim().parse().unwrap_or(0);
    (major, minor)
}

pub fn version_at_least(have: (u32, u32), want: (u32, u32)) -> bool {
    have.0 > want.0 || (have.0 == want.0 && have.1 >= want.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(input: &str) -> Vec<Vec<u8>> {
        tokenize(input).unwrap()
    }

    #[test]
    fn tokenize_splits_on_whitespace_and_honours_quotes() {
        assert_eq!(t("GET  foo"), vec![b"GET".to_vec(), b"foo".to_vec()]);
        assert_eq!(t(r#"SET k "a b""#), vec![b"SET".to_vec(), b"k".to_vec(), b"a b".to_vec()]);
        assert_eq!(t("SET k 'a b'"), vec![b"SET".to_vec(), b"k".to_vec(), b"a b".to_vec()]);
        assert!(t("").is_empty());
        // An empty quoted argument is a real argument, not nothing.
        assert_eq!(t(r#"SET k """#), vec![b"SET".to_vec(), b"k".to_vec(), Vec::new()]);
    }

    /// Arguments are bytes, not `String`: a Redis value may be arbitrary binary and forcing it
    /// through UTF-8 would corrupt what gets written.
    #[test]
    fn tokenize_decodes_escapes_to_raw_bytes() {
        assert_eq!(t(r#"SET k "\xff\x00""#)[2], vec![0xff, 0x00]);
        assert_eq!(t(r#"SET k "a\nb\tc""#)[2], b"a\nb\tc".to_vec());
        // Inside single quotes only \' and \\ are escapes, as in redis-cli, so \n stays literal.
        assert_eq!(t(r"SET k 'a\nb'")[2], br"a\nb".to_vec());
    }

    /// A wrong split is a security decision made on wrong input — the classification below reads
    /// the first token — so an unbalanced quote must fail rather than best-effort.
    #[test]
    fn tokenize_refuses_an_unbalanced_quote() {
        assert!(tokenize(r#"SET k "abc"#).is_err());
        assert!(tokenize("SET k 'abc").is_err());
    }

    #[test]
    fn read_only_classification_is_case_insensitive() {
        assert!(is_read_only_cmd(&t("get foo")));
        assert!(is_read_only_cmd(&t("GET foo")));
        assert!(is_read_only_cmd(&t("HgEtAlL h")));
    }

    /// The whole point of a whitelist: anything not listed counts as a write, including module
    /// commands and whatever a future server version adds. A blacklist could not stay correct.
    #[test]
    fn an_unknown_command_is_treated_as_a_write() {
        for cmd in ["JSON.SET k $ 1", "FT.DROPINDEX idx", "SOMETHING.NEW x", "FLUSHALL", "DEL k"] {
            assert!(!is_read_only_cmd(&t(cmd)), "{cmd}");
        }
        assert!(!is_read_only_cmd(&[]));
    }

    /// A container command is read-only only for the right SUBcommand — `CONFIG GET` reads,
    /// `CONFIG SET` writes, and the bare `CONFIG` decides nothing.
    #[test]
    fn container_commands_are_judged_by_their_subcommand() {
        assert!(is_read_only_cmd(&t("CONFIG GET maxmemory")));
        assert!(!is_read_only_cmd(&t("CONFIG SET maxmemory 0")));
        assert!(!is_read_only_cmd(&t("CONFIG")));
        assert!(is_read_only_cmd(&t("SLOWLOG GET 10")));
        assert!(!is_read_only_cmd(&t("SLOWLOG RESET")));
    }

    /// DEBUG is deliberately absent from the read-only list: `DEBUG SLEEP` and `DEBUG SEGFAULT`
    /// are anything but. TOUCH too — it updates the key's LRU/LFU metadata.
    #[test]
    fn the_deliberate_omissions_stay_omitted() {
        assert!(!is_read_only_cmd(&t("DEBUG SLEEP 10")));
        assert!(!is_read_only_cmd(&t("TOUCH k")));
    }

    #[test]
    fn blocking_commands_are_recognised() {
        for cmd in ["SUBSCRIBE ch", "MONITOR", "BLPOP k 0", "SHUTDOWN", "HELLO 3"] {
            assert!(is_blocking_cmd(&t(cmd)), "{cmd}");
        }
        assert!(!is_blocking_cmd(&t("GET foo")));
    }

    /// XREAD only hijacks the connection when it carries BLOCK; without it the plain form must
    /// stay usable in the console.
    #[test]
    fn xread_blocks_only_with_the_block_option() {
        assert!(is_blocking_cmd(&t("XREAD BLOCK 0 STREAMS s $")));
        assert!(is_blocking_cmd(&t("XREADGROUP GROUP g c BLOCK 0 STREAMS s >")));
        assert!(!is_blocking_cmd(&t("XREAD COUNT 10 STREAMS s 0")));
    }

    /// `SELECT n` typed in the console must be routed like the dropdown, or the connection
    /// switches database while the UI still shows the old index.
    #[test]
    fn select_is_detected_only_in_its_exact_shape() {
        assert_eq!(select_db_arg(&t("SELECT 3")), Some(3));
        assert_eq!(select_db_arg(&t("select 0")), Some(0));
        assert_eq!(select_db_arg(&t("SELECT")), None);
        assert_eq!(select_db_arg(&t("SELECT 1 2")), None);
        assert_eq!(select_db_arg(&t("SELECT abc")), None);
        assert_eq!(select_db_arg(&t("GET 3")), None);
    }

    /// Unparsable input yields (0, 0) so every `version_at_least` check fails — the app falls
    /// back to the most compatible code path rather than assuming a feature exists.
    #[test]
    fn version_parsing_falls_back_to_the_compatible_path() {
        assert_eq!(parse_version("7.4.1"), (7, 4));
        assert_eq!(parse_version("6.0.16"), (6, 0));
        assert_eq!(parse_version(" 255.255.255 "), (255, 255));
        assert_eq!(parse_version("unknown"), (0, 0));
        assert_eq!(parse_version(""), (0, 0));
        assert!(!version_at_least(parse_version("unknown"), (6, 0)));
    }

    #[test]
    fn version_at_least_compares_major_then_minor() {
        assert!(version_at_least((7, 0), (6, 2)));
        assert!(version_at_least((6, 2), (6, 2)));
        assert!(!version_at_least((6, 1), (6, 2)));
        assert!(!version_at_least((5, 9), (6, 0)));
    }
}
