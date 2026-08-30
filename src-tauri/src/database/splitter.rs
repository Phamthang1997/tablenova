//! Splitting a multi-statement SQL string into individual statements.
//!
//! **The twin of `src/sql/statements.ts` — change one side and you must change the other.** The TS one decides
//! what Ctrl+Enter runs and what gets highlighted; this one decides what actually executes. A mismatch means
//! the user runs something other than what they saw highlighted.

// Is this line the mysql client's `DELIMITER <token>` command? Returns the new token.
// It uses `get(..9)` rather than `[..9]`: slicing by byte in the middle of a multi-byte character (Vietnamese...)
// would panic, while `get` returns None.
fn delimiter_token_of_line(line: &str) -> Option<&str> {
    let t = line.trim_start_matches([' ', '\t']);
    if !t.get(..9)?.eq_ignore_ascii_case("DELIMITER") {
        return None;
    }
    let rest = &t[9..];
    if !rest.starts_with([' ', '\t']) {
        return None;
    }
    let token = rest.trim(); // trim also strips the '\r' of a CRLF file
    if token.is_empty() || token.contains(char::is_whitespace) {
        return None;
    }
    Some(token)
}

// Read the DELIMITER command at the start of line `i` (a character index into `chars`).
// Returns (the new token, the index right after that line). This command is NOT SQL: sending it to the server errors out.
fn read_delimiter_command(chars: &[char], i: usize) -> Option<(String, usize)> {
    let line_end = chars[i..]
        .iter()
        .position(|&c| c == '\n')
        .map(|p| i + p)
        .unwrap_or(chars.len());
    let line: String = chars[i..line_end].iter().collect();
    let token = delimiter_token_of_line(&line)?.to_string();
    let next = if line_end < chars.len() {
        line_end + 1
    } else {
        chars.len()
    };
    Some((token, next))
}

// Does `chars[i..]` match the statement terminator currently in force?
fn matches_delimiter(chars: &[char], i: usize, delim: &[char]) -> bool {
    if i + delim.len() > chars.len() {
        return false;
    }
    chars[i..i + delim.len()] == *delim
}

// Split a multi-statement SQL string into individual statements. It recognises:
//   - quoted strings ('..', "..", `..`) and '\' escapes
//   - comment `-- ...`, `# ...`, `/* ... */`
//   - Postgres dollar-quoted blocks ($$ ... $$, $tag$ ... $tag$) — a function body contains ';'
//   - MySQL's DELIMITER command — it changes the statement terminator so trigger/procedure bodies can be written
// Without the last two, a file containing a function/trigger would be cut in the middle of the body and could
// run a statement that sits inside it by mistake.
/// Strip the whitespace and comments at the START of a statement, returning the part that begins with a real SQL keyword.
///
/// The splitter keeps comments inside the statement text, so in a mysqldump dump
///     `-- Dumping data for table `store`` + newline + `LOCK TABLES `store` WRITE`
/// is ONE statement beginning with "--". Classifying by the raw text gets all of it wrong:
/// LOCK/UNLOCK TABLES is not skipped, and `SET`/`USE` is not treated as a session-level statement.
pub(crate) fn strip_leading_comments(stmt: &str) -> &str {
    let b = stmt.as_bytes();
    let mut i = 0usize;
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        // Line comment: -- ... or # ...
        if (i + 1 < b.len() && b[i] == b'-' && b[i + 1] == b'-') || (i < b.len() && b[i] == b'#') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Block comment: /* ... */ (including MySQL's conditional comments /*!40101 ... */)
        if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
            continue;
        }
        break;
    }
    // i always stops after '\n' / '*/' / an ASCII space, so it is still a UTF-8 character boundary.
    &stmt[i.min(stmt.len())..]
}

// Statement head is `CREATE [OR REPLACE] [TEMP|TEMPORARY] [DEFINER=...] TRIGGER`.
fn is_create_trigger_head(seg: &str) -> bool {
    let head = strip_leading_comments(seg).trim_start();
    let mut words = head.split_whitespace();
    if !words
        .next()
        .is_some_and(|w| w.eq_ignore_ascii_case("CREATE"))
    {
        return false;
    }
    for w in words.take(4) {
        if w.eq_ignore_ascii_case("TRIGGER") {
            return true;
        }
        let is_modifier = w.eq_ignore_ascii_case("OR")
            || w.eq_ignore_ascii_case("REPLACE")
            || w.eq_ignore_ascii_case("TEMP")
            || w.eq_ignore_ascii_case("TEMPORARY")
            // MySQL writes the whole clause as one token: DEFINER=`root`@`localhost`
            || w.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("DEFINER"));
        if !is_modifier {
            return false;
        }
    }
    false
}

/// Is this `;` still INSIDE a trigger body rather than the end of the statement?
///
/// A `BEGIN ... END` body carries its own `;`, so splitting on the first one yields a truncated
/// `CREATE TRIGGER ... BEGIN UPDATE t SET ...;` — SQLite answers "incomplete input" and the whole
/// restore rolls back. MySQL avoids this with the client-side `DELIMITER` command, SQLite has no
/// such thing, so the rule has to live here. It is what `sqlite3_complete()` does: a statement
/// starting with CREATE TRIGGER only ends at the `;` that directly follows the `END` keyword.
///
/// Requiring `BEGIN` matters: a Postgres trigger (`... EXECUTE FUNCTION f();`) and MySQL's
/// single-statement form (`... FOR EACH ROW SET NEW.a = 1;`) have no BEGIN block, and making
/// them wait for an `END` would swallow the rest of the dump into one statement.
///
/// Twin of `insideTriggerBody()` in src/sql/statements.ts — keep both in sync.
fn trigger_stmt_incomplete(seg: &str) -> bool {
    if !is_create_trigger_head(seg) {
        return false;
    }
    let b: Vec<char> = seg.chars().collect();
    let n = b.len();
    let mut i = 0usize;
    let mut has_begin = false;
    let mut last_word_is_end = false;

    while i < n {
        let c = b[i];
        let peek = if i + 1 < n { Some(b[i + 1]) } else { None };

        if (c == '-' && peek == Some('-')) || (c == '#' && !matches!(peek, Some('>') | Some('-'))) {
            while i < n && b[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && peek == Some('*') {
            i += 2;
            while i + 1 < n && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        if c == '\'' || c == '"' || c == '`' {
            let quote = c;
            i += 1;
            while i < n {
                if b[i] == '\\' && quote != '`' {
                    i += 2;
                    continue;
                }
                if b[i] == quote {
                    if quote == '\'' && i + 1 < n && b[i + 1] == '\'' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            last_word_is_end = false;
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let s = i;
            while i < n && (b[i].is_alphanumeric() || b[i] == '_' || b[i] == '$') {
                i += 1;
            }
            let word: String = b[s..i].iter().collect();
            if word.eq_ignore_ascii_case("BEGIN") {
                has_begin = true;
            }
            last_word_is_end = word.eq_ignore_ascii_case("END");
            continue;
        }
        if !c.is_whitespace() {
            last_word_is_end = false;
        }
        i += 1;
    }

    has_begin && !last_word_is_end
}

// Cheap pre-check for the rule above: skip leading whitespace/comments and compare six chars.
// A dump of INSERTs bails out on the first character instead of rebuilding every statement
// into a String only to find it is not a trigger.
fn seg_may_be_create(chars: &[char], from: usize, to: usize) -> bool {
    let mut i = from;
    loop {
        while i < to && chars[i].is_whitespace() {
            i += 1;
        }
        if i + 1 < to && chars[i] == '-' && chars[i + 1] == '-' {
            while i < to && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if i + 1 < to && chars[i] == '/' && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < to && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(to);
            continue;
        }
        break;
    }
    const KW: [char; 6] = ['C', 'R', 'E', 'A', 'T', 'E'];
    if i + KW.len() > to {
        return false;
    }
    KW.iter()
        .enumerate()
        .all(|(k, ch)| chars[i + k].to_ascii_uppercase() == *ch)
}

pub(crate) fn split_sql_statements(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();
    // `DELIMITER` only appears in MySQL scripts; there '$$' is a statement terminator, not a dollar quote.
    let mysql_script = sql.lines().any(|l| delimiter_token_of_line(l).is_some());

    let mut out: Vec<String> = Vec::new();
    let mut delim: Vec<char> = vec![';'];
    let mut start = 0usize; // the start of the statement being gathered
    let mut at_line_start = true;
    let mut i = 0usize;

    let push_stmt = |out: &mut Vec<String>, from: usize, to: usize| {
        let s: String = chars[from..to].iter().collect();
        let s = s.trim().to_string();
        if !s.is_empty() {
            out.push(s);
        }
    };

    while i < n {
        let c = chars[i];
        let peek = if i + 1 < n { Some(chars[i + 1]) } else { None };

        // Line comment: -- ... | # ...  ('#>' and '#-' are Postgres jsonb operators, not comments)
        if (c == '-' && peek == Some('-')) || (c == '#' && !matches!(peek, Some('>') | Some('-'))) {
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            at_line_start = true;
            i += 1; // skip the '\n'
            continue;
        }
        // Block comment: /* ... */
        if c == '/' && peek == Some('*') {
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(n);
            at_line_start = false;
            continue;
        }
        // A quoted string / quoted identifier: skip the whole block (including \' and '' escapes)
        if c == '\'' || c == '"' || c == '`' {
            let quote = c;
            i += 1;
            while i < n {
                if chars[i] == '\\' && quote != '`' {
                    i += 2;
                    continue;
                }
                if chars[i] == quote {
                    if quote == '\'' && i + 1 < n && chars[i + 1] == '\'' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            at_line_start = false;
            continue;
        }
        // A Postgres dollar-quoted block: $$ ... $$ or $tag$ ... $tag$ (not $1 or ${x})
        if !mysql_script && c == '$' {
            let mut j = i + 1;
            while j < n && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if j < n
                && chars[j] == '$'
                && (j == i + 1 || chars[i + 1].is_ascii_alphabetic() || chars[i + 1] == '_')
            {
                let tag: Vec<char> = chars[i..=j].to_vec();
                let mut k = j + 1;
                while k < n && !matches_delimiter(&chars, k, &tag) {
                    k += 1;
                }
                i = if k < n { k + tag.len() } else { n };
                at_line_start = false;
                continue;
            }
        }
        // The DELIMITER command (at the start of a line): it changes the statement terminator, and the line itself is not a statement
        if at_line_start {
            if let Some((token, next)) = read_delimiter_command(&chars, i) {
                push_stmt(&mut out, start, i);
                delim = token.chars().collect();
                start = next;
                i = next;
                at_line_start = true;
                continue;
            }
        }
        // The statement terminator currently in force
        if matches_delimiter(&chars, i, &delim) {
            // A ';' inside a trigger's BEGIN...END body is not the end of the statement. Only
            // while the delimiter is still ';': a MySQL script that issued DELIMITER already
            // protects the body that way.
            if delim.len() == 1
                && delim[0] == ';'
                && seg_may_be_create(&chars, start, i)
                && trigger_stmt_incomplete(&chars[start..i].iter().collect::<String>())
            {
                i += 1;
                at_line_start = false;
                continue;
            }
            push_stmt(&mut out, start, i);
            i += delim.len();
            start = i;
            at_line_start = false;
            continue;
        }

        at_line_start = c == '\n';
        i += 1;
    }

    push_stmt(&mut out, start, n);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(sql: &str) -> Vec<String> {
        split_sql_statements(sql)
    }

    #[test]
    fn splits_on_the_semicolon_and_trims() {
        assert_eq!(split("SELECT 1; SELECT 2"), ["SELECT 1", "SELECT 2"]);
        assert_eq!(
            split("SELECT 1;\r\nSELECT 2;\r\n"),
            ["SELECT 1", "SELECT 2"]
        );
        assert!(split("   \n\t ").is_empty());
    }

    #[test]
    fn a_semicolon_inside_a_string_or_a_comment_is_not_a_separator() {
        assert_eq!(split("SELECT ';'; SELECT 2"), ["SELECT ';'", "SELECT 2"]);
        assert_eq!(
            split("SELECT 1 -- a;b\n; /* c;d */ SELECT 2"),
            ["SELECT 1 -- a;b", "/* c;d */ SELECT 2"]
        );
    }

    /// Deliberately DIFFERENT from the TS twin (`src/sql/statements.ts`), which drops a segment
    /// that is only a comment. Here they survive: `restore_backup` filters them itself through
    /// `is_skipped_stmt`, and dropping them would lose a dump's own header comments before that
    /// decision is made.
    #[test]
    fn a_comment_only_segment_survives() {
        assert_eq!(
            split("-- hi\nSELECT 1;\n/* block */"),
            ["-- hi\nSELECT 1", "/* block */"]
        );
    }

    #[test]
    fn a_dollar_quoted_body_is_not_split() {
        assert_eq!(
            split(
                "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql; SELECT 1"
            ),
            [
                "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql",
                "SELECT 1"
            ]
        );
        assert_eq!(
            split(
                "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql; SELECT 2"
            ),
            [
                "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql",
                "SELECT 2"
            ]
        );
    }

    /// A bind placeholder and a query parameter both start with `$` and must not open a block —
    /// if they did, everything after `$1` would be swallowed into one statement.
    #[test]
    fn a_bind_placeholder_does_not_open_a_dollar_block() {
        assert_eq!(
            split("SELECT $1; SELECT ${x}"),
            ["SELECT $1", "SELECT ${x}"]
        );
    }

    /// The DELIMITER line is a CLIENT command: it is consumed here and never sent to the server,
    /// which would reject it.
    #[test]
    fn the_delimiter_line_is_consumed_never_emitted() {
        assert_eq!(
            split(
                "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nSELECT 2;"
            ),
            ["CREATE PROCEDURE p() BEGIN SELECT 1; END", "SELECT 2"]
        );
        // mysqldump --routines writes `;;`.
        assert_eq!(
            split("DELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 1; END;;\nDELIMITER ;"),
            ["CREATE PROCEDURE p() BEGIN SELECT 1; END"]
        );
    }

    /// In a script that uses DELIMITER, `$$` is the statement terminator — not a Postgres
    /// dollar-quote. Reading it as one would merge the whole file into a single statement.
    #[test]
    fn dollar_dollar_is_a_terminator_in_a_delimiter_script() {
        let sql = "DELIMITER $$\nCREATE PROCEDURE a() BEGIN SELECT 1; END$$\nCREATE PROCEDURE b() BEGIN SELECT 2; END$$";
        assert_eq!(split(sql).len(), 2);
    }

    #[test]
    fn delimiter_is_only_a_command_at_the_start_of_a_line() {
        assert_eq!(
            split("SELECT 'DELIMITER $$'; SELECT 2"),
            ["SELECT 'DELIMITER $$'", "SELECT 2"]
        );
        assert_eq!(
            split("SELECT 1 DELIMITER //;\nSELECT 2;"),
            ["SELECT 1 DELIMITER //", "SELECT 2"]
        );
    }

    /// Outside a script that issued DELIMITER, `$$` is a Postgres dollar-quote and nothing else —
    /// even right after the word DELIMITER. That is why `mysql_script` is decided once for the
    /// WHOLE input rather than per statement: the same two characters cannot mean both things in
    /// one file, and guessing per statement would split a Postgres function body in half.
    #[test]
    fn outside_a_delimiter_script_dollar_dollar_always_opens_a_block() {
        assert_eq!(
            split("SELECT 1 DELIMITER $$;\nSELECT 2;"),
            ["SELECT 1 DELIMITER $$;\nSELECT 2;"]
        );
    }

    /// `sqlite3_complete()`'s rule, and SQLite needs it because it has no DELIMITER: a trigger
    /// whose body contains BEGIN only ends at the `;` that follows END. Without this an exported
    /// trigger came back truncated and killed the whole restore.
    #[test]
    fn a_trigger_body_holds_together() {
        assert_eq!(
            split("CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = 1; END;\nSELECT 9;"),
            [
                "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = 1; END",
                "SELECT 9"
            ]
        );
        // END, then a comment, then the terminator.
        assert_eq!(
            split(
                "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n=1; END -- done\n;\nSELECT 9;"
            ),
            [
                "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n=1; END -- done",
                "SELECT 9"
            ]
        );
    }

    /// Requiring the BEGIN word is what keeps the rule from swallowing the rest of a dump: a
    /// Postgres trigger and MySQL's single-statement form both end at their first `;`.
    #[test]
    fn a_trigger_without_begin_ends_at_its_first_semicolon() {
        assert_eq!(
            split("CREATE TRIGGER t AFTER INSERT ON a EXECUTE FUNCTION f();\nSELECT 9;"),
            [
                "CREATE TRIGGER t AFTER INSERT ON a EXECUTE FUNCTION f()",
                "SELECT 9"
            ]
        );
        assert_eq!(
            split("CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW SET NEW.x = 1;\nSELECT 9;"),
            [
                "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW SET NEW.x = 1",
                "SELECT 9"
            ]
        );
    }

    /// The rule is scoped to triggers: a BEGIN that is only a value, and any other CREATE, must
    /// split normally.
    #[test]
    fn the_trigger_rule_does_not_leak_to_other_statements() {
        assert_eq!(
            split("INSERT INTO t VALUES ('BEGIN'); SELECT 1;"),
            ["INSERT INTO t VALUES ('BEGIN')", "SELECT 1"]
        );
        assert_eq!(
            split("CREATE TABLE t (a INT); SELECT 1;"),
            ["CREATE TABLE t (a INT)", "SELECT 1"]
        );
    }

    #[test]
    fn strip_leading_comments_reaches_the_first_keyword() {
        assert_eq!(
            strip_leading_comments("-- header\n/* x */\n  SELECT 1"),
            "SELECT 1"
        );
        assert_eq!(strip_leading_comments("SELECT 1"), "SELECT 1");
        assert_eq!(strip_leading_comments("  /* only */  ").trim(), "");
    }
}
