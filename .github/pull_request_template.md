<!--
CI on this repo covers the RUST side only: cargo build, cargo test, cargo clippy.
The frontend checks are NOT in CI — run them locally before you push:

  npx oxlint  &&  npx tsc --noEmit  &&  npm run test
  cd src-tauri  &&  cargo clippy --all-targets -- -D warnings  &&  cargo test --lib

Conventions: CONTRIBUTING.md · docs/CODING_STANDARDS.md
-->

## Summary

<!-- What changed and why it was needed. 2–5 sentences, from the user's or the product's point of view. -->

## Type of change

* [ ] Feature
* [ ] Bugfix
* [ ] Refactor / cleanup
* [ ] Performance
* [ ] Build / CI / dependency
* [ ] Docs
* [ ] Security
* [ ] i18n / localization

## Linked issue

Closes #

## Key changes

<!-- Bullets by module or by behaviour. Do not list files one by one. -->

*
*
*

## Technical decisions

<!-- Fill in only when there is a trade-off, an option considered and rejected, or a known limitation. Write "None" if there is none. -->

*

## Out of scope / follow-ups

<!-- What this PR deliberately does NOT do, and what is left for a later PR. "None" is a valid answer. -->

*

## Testing

**Verified:**

* [ ] Happy path
* [ ] Empty or invalid input
* [ ] Error path
* [ ] Regression on the surrounding features

**Ran against:**

<!-- Most bugs in this app are dialect-specific. Tick what you actually ran, not what ought to work. -->

* [ ] SQLite
* [ ] PostgreSQL
* [ ] MySQL
* [ ] Redis
* [ ] N/A — no database code touched

**How to re-verify:**

1.
2.
3.

## Cross-cutting checks

<details>
<summary>Open if this PR crosses the Rust ↔ TypeScript boundary, or touches the editor / build config</summary>

Nothing enforces the pairs below. They drift silently, and the failure shows up as
wrong behaviour rather than as a build error.

* [ ] New `#[tauri::command]` → registered in `src-tauri/src/app/handlers.rs`
      *(missing = "unknown command" at runtime; the compiler will not catch it)*
* [ ] New backend capability → matching method in `src/utils/dbHelper.ts`
* [ ] New `redis_*` command → classified in `src/utils/safeMode.ts`
      *(`safeMode.test.ts` fails on an unclassified one)*
* [ ] Statement splitting changed → `src-tauri/src/database/splitter.rs` **and** `src/sql/statements.ts`
* [ ] A Rust error message reworded → `src/utils/backendErrors.ts`
* [ ] Redis SSL handling changed → `redis_ssl_mode()` **and** `REDIS_SSL_MODES` in `ConnectionManager.tsx`
* [ ] The JSON shape a command returns changed → types in `dbHelper.ts`
* [ ] Touched an editor component or `vite.config.mts` → the `monaco` chunk is still absent
      from the `modulepreload` list in `dist/index.html` after `npm run build-frontend`

</details>

## Impact & risk

* **Breaking change:** no / yes →
* **Migration, schema, config or env change:** no / yes →
* **Needs a native rebuild or an app version bump:** no / yes
* **Rollback plan:**

## Screenshots

<!-- UI changes only; delete this section otherwise. Show light AND dark theme when colours changed. -->

| Before | After |
| ------ | ----- |
|        |       |

## Checklist

* [ ] Rust CI green (build, test, clippy)
* [ ] Frontend checks run locally: `npx oxlint`, `npx tsc --noEmit`, `npm run test`
* [ ] Read the whole diff myself
* [ ] Added or updated tests for the changed behaviour
* [ ] Updated docs / doc comments where behaviour changed
* [ ] Every user-facing string goes through i18n — a key in `en.ts` + `vi.ts` + `ja.ts`, never a literal
* [ ] No leftover debug code, `console.log`, throwaway `unwrap()` or stray TODO
* [ ] No secrets, tokens or connection credentials — screenshots included

## Notes for the reviewer

<!-- What to read closely, what is only moved code, where you want a second opinion. -->

*
