//! FTS5 `MATCH` query preparation for user/agent-supplied search text.
//!
//! FTS5 treats `column:term` as a column-qualified search. Natural-language
//! queries that contain bare colons (`pick: handoff`, `memory: bootstrap`) make
//! SQLite error with `no such column: pick` because only `title` and `body`
//! exist on the FTS tables. Unknown bare column syntax is neutralised without
//! discarding deliberate FTS operators such as `OR`.

/// Sanitize free-text for use in `WHERE pages_fts MATCH ?`.
///
/// Returns an empty string when `raw` is empty/whitespace-only; callers
/// should skip the SQL query in that case.
///
/// Bare multi-word queries are joined with **`OR`**, not the FTS5 default
/// (`AND`). A natural-language query like "cross project search strategy"
/// otherwise requires every word to co-occur in one page — near-zero recall
/// for anything but single keywords. With `OR` + bm25 ranking (callers
/// `ORDER BY rank`), the best-matching pages still surface first. When the
/// caller supplies explicit FTS5 syntax (`OR` / `AND` / `NOT` / `NEAR` /
/// quoted phrases / parens) we preserve it verbatim instead.
#[must_use]
pub fn prepare_fts5_query(raw: &str) -> String {
    let explicit_syntax = raw.contains('"')
        || raw.contains('(')
        || raw.contains(')')
        || raw
            .split_whitespace()
            .any(|t| matches!(t, "OR" | "AND" | "NOT" | "NEAR"));
    let tokens: Vec<String> = raw
        .split_whitespace()
        // Bare natural-language queries drop stopwords before the
        // OR-join: with no tokenizer-level stopword list, "the/of/a"
        // match nearly every page and BM25 term frequency lets a page
        // with five "the"s outrank the page whose CONTENT matches (seen
        // live: a release-procedure page beaten for a deploy question).
        // Explicit-syntax queries and quoted phrases are untouched, and
        // a query that is ONLY stopwords keeps them all — returning the
        // user's literal terms beats returning nothing.
        .filter(|t| explicit_syntax || !is_stopword(t))
        .flat_map(prepare_fts5_token)
        .collect();
    let tokens = if tokens.is_empty() && !explicit_syntax {
        raw.split_whitespace()
            .flat_map(prepare_fts5_token)
            .collect()
    } else {
        tokens
    };
    if tokens.is_empty() {
        return String::new();
    }
    let separator = if explicit_syntax { " " } else { " OR " };
    let candidate = tokens.join(separator);
    // Natural language trips the explicit-syntax path constantly — `(MoMA)`,
    // `'quoted phrases'`, a sentence that happens to contain OR — and a
    // preserved-verbatim mix can be grammatically invalid FTS5 (a quoted
    // OR-group adjacent to a bare term has no implicit AND, for one). The
    // MATCH must never error on user text, so validate the candidate against
    // a real FTS5 parser and degrade to the always-valid quoted bag of words
    // when it does not parse. Deliberate, well-formed operator queries pass
    // validation and are preserved.
    if fts5_query_parses(&candidate) {
        return candidate;
    }
    raw.split_whitespace()
        .flat_map(|token| {
            // Re-tokenize with every operator neutralised: strip quotes and
            // parens, then quote what remains.
            let cleaned: String = token
                .chars()
                .map(|c| if matches!(c, '"' | '(' | ')') { ' ' } else { c })
                .collect();
            cleaned
                .split_whitespace()
                .map(quote_fts5_token)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// Whether FTS5's own parser accepts `query`. Uses a throwaway in-memory
/// table (microseconds; search-path frequency, not ingest-path) so the
/// judgement is the engine's, not a re-implementation of its grammar.
fn fts5_query_parses(query: &str) -> bool {
    thread_local! {
        // One probe connection per thread: opening a fresh in-memory
        // database per search query was measurable overhead on the
        // read-pool hot path (post-audit nit).
        static PROBE: Option<rusqlite::Connection> = {
            let conn = rusqlite::Connection::open_in_memory().ok();
            if let Some(c) = &conn
                && c.execute_batch("CREATE VIRTUAL TABLE fts_probe USING fts5(title, body)")
                    .is_err()
            {
                None
            } else {
                conn
            }
        };
    }
    PROBE.with(|probe| {
        probe.as_ref().is_some_and(|conn| {
            conn.query_row(
                "SELECT count(*) FROM fts_probe WHERE fts_probe MATCH ?1",
                [query],
                |row| row.get::<_, i64>(0),
            )
            .is_ok()
        })
    })
}

/// English stopwords excluded from bare-query OR-joins. Deliberately
/// small and boring: high-document-frequency function words that carry
/// no retrieval signal but dominate BM25 through term frequency. Words
/// inside quoted phrases and explicit-operator queries never pass
/// through this filter.
fn is_stopword(token: &str) -> bool {
    matches!(
        token.to_ascii_lowercase().as_str(),
        "a" | "an"
            | "and"
            | "are"
            | "as"
            | "at"
            | "be"
            | "been"
            | "but"
            | "by"
            | "can"
            | "could"
            | "did"
            | "do"
            | "does"
            | "for"
            | "from"
            | "had"
            | "has"
            | "have"
            | "how"
            | "i"
            | "if"
            | "in"
            | "is"
            | "it"
            | "its"
            | "me"
            | "my"
            | "of"
            | "on"
            | "or"
            | "our"
            | "she"
            | "should"
            | "so"
            | "that"
            | "the"
            | "their"
            | "them"
            | "they"
            | "this"
            | "to"
            | "was"
            | "we"
            | "were"
            | "what"
            | "when"
            | "where"
            | "which"
            | "who"
            | "why"
            | "will"
            | "with"
            | "would"
            | "you"
            | "your"
    )
}

fn prepare_fts5_token(token: &str) -> Vec<String> {
    if has_unknown_bare_column(token) {
        return token
            .replace(':', " ")
            .split_whitespace()
            .map(quote_fts5_token)
            .collect();
    }

    if should_quote_fts5_token(token) {
        vec![quote_fts5_token(token)]
    } else {
        vec![token.to_string()]
    }
}

fn has_unknown_bare_column(token: &str) -> bool {
    token.contains(':')
        && !token.contains('"')
        && !token.starts_with("title:")
        && !token.starts_with("body:")
}

fn should_quote_fts5_token(token: &str) -> bool {
    if token.starts_with('"') && token.ends_with('"') {
        return false;
    }
    // Quote any token carrying ASCII punctuation so FTS5 treats it as a literal
    // phrase instead of erroring on its query grammar — e.g. a filename like
    // `current.md` otherwise yields `fts5: syntax error near "."`. A trailing
    // `*` (the FTS5 prefix operator) is allowed through bare; accented letters
    // and digits are unicode (not ASCII punctuation) so recall keeps accents.
    let core = token.strip_suffix('*').unwrap_or(token);
    // `:` is column syntax (handled by `has_unknown_bare_column`, or preserved
    // for known `title:`/`body:` columns) — it must not trigger quoting here.
    core.chars().any(|c| c.is_ascii_punctuation() && c != ':')
}

fn quote_fts5_token(token: &str) -> String {
    // FTS5 escapes `"` by doubling it. A token carrying a literal quote is an
    // explicit-phrase fragment — keep the simple escaped form (don't expand it).
    if token.contains('"') {
        return format!("\"{}\"", token.replace('"', "\"\""));
    }
    // Otherwise emit BOTH the whole token and a punctuation-stripped sub-token
    // phrase, OR'd, because the content tokenizer and the path index disagree
    // on punctuation:
    //   tokenize = "unicode61 remove_diacritics 2 tokenchars '/_-'"
    // keeps `/ _ -` INSIDE tokens (so a body mention of `ai-memory` indexes as
    // the single token `ai-memory`), while `ops::path_search_text` pre-expands
    // `/ . - _` to spaces in the path index (so a path `ui-refresh-…` indexes
    // the sub-tokens `ui`, `refresh`, …). `.` is a separator either way.
    // Neither form alone matches both: `"ai-memory"` matches the content token
    // but not the split path index; `"ai memory"` matches the path but not the
    // content token. OR-ing the two makes a search for `ai-memory` / `ui-refresh`
    // hit whichever surface indexed it. (Quoting both also neutralises the
    // punctuation that would otherwise be FTS5 query grammar — the original
    // `current.md` → `syntax error` bug.) With no punctuation the two coincide
    // and we emit a single phrase.
    let split = token
        .chars()
        .map(|c| if c.is_ascii_punctuation() { ' ' } else { c })
        .collect::<String>();
    let split = split.split_whitespace().collect::<Vec<_>>().join(" ");
    if split.is_empty() || split == token {
        format!("\"{token}\"")
    } else {
        format!("(\"{token}\" OR \"{split}\")")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The engine, not this module, is the judge of validity: every
    /// prepared query must MATCH without error on a real FTS5 table.
    fn assert_parses(prepared: &str) {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE t USING fts5(title, body)")
            .unwrap();
        let res = conn.query_row(
            "SELECT count(*) FROM t WHERE t MATCH ?1",
            [prepared],
            |row| row.get::<_, i64>(0),
        );
        assert!(res.is_ok(), "FTS5 rejected {prepared:?}: {res:?}");
    }

    /// Regression (found by the LongMemEval harness): a natural-language
    /// question containing parens and apostrophe-quotes tripped the
    /// explicit-syntax path and produced invalid FTS5 — `fts5: syntax
    /// error near "OR"` — failing the whole memory_query call.
    #[test]
    fn natural_language_with_parens_and_quotes_never_errors() {
        let raw = "How many days passed between my visit to the Museum of \
                   Modern Art (MoMA) and the 'Ancient Civilizations' exhibit \
                   at the Metropolitan Museum of Art?";
        let prepared = prepare_fts5_query(raw);
        assert_parses(&prepared);
        // and the degraded form still carries the searchable words
        assert!(prepared.contains("MoMA"));
        assert!(prepared.contains("Civilizations"));
    }

    #[test]
    fn hostile_operator_soup_never_errors() {
        for raw in [
            "((",
            "\"unclosed phrase",
            "NEAR(",
            "OR",
            "a OR",
            "OR b",
            "NOT",
            ") misplaced (",
            "col:val:col ( OR \" NEAR",
            "\"\"\"",
        ] {
            let prepared = prepare_fts5_query(raw);
            if !prepared.is_empty() {
                assert_parses(&prepared);
            }
        }
    }

    #[test]
    fn deliberate_well_formed_syntax_is_preserved() {
        let prepared = prepare_fts5_query("title:handoff OR body:deploy");
        assert_parses(&prepared);
        assert_eq!(prepared, "title:handoff OR body:deploy");
        // Quoted phrases were re-tokenized into escaped-quote form long
        // before the validation fallback existed; the contract here is
        // "still valid FTS5 with AND preserved", not byte identity.
        let phrase = prepare_fts5_query("\"exact phrase\" AND deploy");
        assert_parses(&phrase);
        assert!(phrase.contains(" AND deploy"), "{phrase}");
    }

    #[test]
    fn colon_is_not_column_syntax() {
        // Bare multi-word → OR-joined (no explicit operator present).
        // `ai-memory` expands to BOTH the whole token (matches content) and
        // the sub-token phrase (matches the split path index) — see
        // `quote_fts5_token`.
        let q = prepare_fts5_query("pick: handoff ai-memory");
        assert_eq!(q, "\"pick\" OR handoff OR (\"ai-memory\" OR \"ai memory\")");
    }

    #[test]
    fn bare_multi_word_is_or_joined() {
        // The recall fix: every word no longer has to co-occur.
        assert_eq!(
            prepare_fts5_query("cross project search strategy"),
            "cross OR project OR search OR strategy"
        );
    }

    #[test]
    fn portuguese_accented_terms_or_join_and_keep_accents() {
        // PT natural-language query: tokens preserved (accents intact),
        // joined with OR so a page matching any term is found.
        assert_eq!(
            prepare_fts5_query("descrição testes commits"),
            "descrição OR testes OR commits"
        );
    }

    #[test]
    fn single_word_has_no_or() {
        assert_eq!(prepare_fts5_query("handoff"), "handoff");
    }

    /// Regression: a filename like `current.md` used to pass through bare and
    /// FTS5 errored with `syntax error near "."`. Quoting it as a phrase both
    /// avoids the error and matches `architecture-current.md` (the tokens
    /// `current` + `md` are adjacent in the indexed path).
    #[test]
    fn dotted_filename_token_is_quoted() {
        // Whole token OR sub-token phrase. The split form (`current md`)
        // matches the tokenised path; the whole form covers content tokens.
        assert_eq!(
            prepare_fts5_query("current.md"),
            "(\"current.md\" OR \"current md\")"
        );
        assert_eq!(
            prepare_fts5_query("00-index.md"),
            "(\"00-index.md\" OR \"00 index md\")"
        );
        assert_eq!(
            prepare_fts5_query("a/b/c.md"),
            "(\"a/b/c.md\" OR \"a b c md\")"
        );
    }

    /// Regression for the live-found bug: searching `ui-refresh` returned
    /// nothing even though `follow-ups/ui-refresh-scroll-restoration.md`
    /// exists. The old quoting produced `"ui-refresh"`, which FTS5 does NOT
    /// match against the indexed `ui refresh`; the sub-token phrase
    /// `"ui refresh"` does. See the real-FTS5 test in `ops.rs`.
    #[test]
    fn hyphenated_token_quotes_as_subtoken_phrase() {
        assert_eq!(
            prepare_fts5_query("ui-refresh"),
            "(\"ui-refresh\" OR \"ui refresh\")"
        );
        assert_eq!(
            prepare_fts5_query("scroll-restoration"),
            "(\"scroll-restoration\" OR \"scroll restoration\")"
        );
    }

    /// The FTS5 prefix operator (`term*`) must survive — a trailing `*` is not
    /// quoted away.
    #[test]
    fn prefix_star_token_stays_bare() {
        assert_eq!(prepare_fts5_query("curr*"), "curr*");
    }

    #[test]
    fn empty_yields_empty() {
        assert_eq!(prepare_fts5_query("   "), "");
    }

    #[test]
    fn quote_emits_whole_and_subtoken_phrase() {
        // Punctuated identifier → both forms OR'd.
        assert_eq!(
            quote_fts5_token("ai-memory"),
            r#"("ai-memory" OR "ai memory")"#
        );
        // A literal-quote fragment keeps the simple escaped form (no expansion).
        assert_eq!(quote_fts5_token(r#"say "hello""#), r#""say ""hello""""#);
        // No punctuation → single phrase.
        assert_eq!(quote_fts5_token("handoff"), r#""handoff""#);
    }

    #[test]
    fn boolean_operators_are_preserved() {
        assert_eq!(prepare_fts5_query("quick OR slow"), "quick OR slow");
    }

    /// AND is the FTS5 default but operators can be explicit — when the
    /// caller writes one, the OR-join must NOT mangle it into
    /// `foo OR AND OR bar`. Same for NOT and NEAR. (The escape hatch from
    /// the broad-recall default is what makes the OR-join safe to land.)
    #[test]
    fn explicit_and_operator_is_preserved() {
        assert_eq!(prepare_fts5_query("foo AND bar"), "foo AND bar");
    }

    #[test]
    fn explicit_not_operator_is_preserved() {
        assert_eq!(prepare_fts5_query("foo NOT bar"), "foo NOT bar");
    }

    #[test]
    fn explicit_near_operator_is_preserved() {
        assert_eq!(prepare_fts5_query("foo NEAR bar"), "foo NEAR bar");
    }

    /// A query containing a quoted phrase is treated as explicit FTS5
    /// syntax — `"exact phrase" baz` must not become
    /// `"exact" OR "phrase" OR baz` (which destroys the phrase semantics).
    /// The exact assertion is "space-joined, not OR-joined"; what the
    /// individual tokens look like after `prepare_fts5_token` is a
    /// separate concern (and unchanged from pre-#58 behaviour).
    #[test]
    fn quoted_phrase_query_is_not_or_joined() {
        let q = prepare_fts5_query("\"exact phrase\" baz");
        assert!(
            !q.contains(" OR "),
            "explicit quoted-phrase query must not get OR-joined; got {q}"
        );
    }

    /// Same escape-hatch logic for parenthesised sub-expressions —
    /// `(foo OR bar) AND baz` must survive unmangled.
    #[test]
    fn parenthesised_query_is_not_or_joined() {
        let q = prepare_fts5_query("(foo OR bar) AND baz");
        assert!(
            !q.contains("OR (foo"),
            "parens detection must skip OR-join entirely; got {q}"
        );
        assert!(
            q.contains("AND"),
            "explicit AND inside parens query must survive; got {q}"
        );
    }

    #[test]
    fn known_columns_are_preserved() {
        assert_eq!(prepare_fts5_query("title:handoff"), "title:handoff");
    }
}
