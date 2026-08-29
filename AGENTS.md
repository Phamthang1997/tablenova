# Project Rules & Guidelines for TableNova

## CSS & Styling Rules
- **No Inline CSS Allowed** (`style={{ ... }}`).
- All UI styling must use **CSS Classes** defined in `src/index.css` (or corresponding component `.css` files).
- **Sole Exception**: Inline styles are only permitted when property values are dynamically calculated at runtime (such as mouse coordinates, progress percentages, dynamic colors chosen from a user picker).

## UI & Button Design Rules
- **Always match TableNova's existing button design**: Each option or action must be an independent button with its own border (`1px solid var(--win-border)`), `border-radius: 6px`, transparent background, and hover/active transition effects changing border and color to `var(--win-accent)`.
- **Never group buttons into a fused pill container (iOS-style segmented control)**: Do not wrap option buttons into a shared continuous capsule container.

## Rust Module Structure & Features (`src-tauri`)
- **Organize strictly by domain directory**:
  - Features belonging to existing domains (`database`, `redis_db`, `compare`, `credentials`, `datagen`, `ssh`, `terminal`, `stats`, `tx`, `state`, `app`) must be placed in their respective folder under `src-tauri/src/<domain>/`.
  - New domain/feature: Create a new directory `src-tauri/src/<feature_name>/` with `mod.rs` and declare `pub mod <feature_name>;` in `src-tauri/src/lib.rs`.
- **Do not write logic directly in `src-tauri/src/lib.rs` or `main.rs`**: `lib.rs` is solely for module declarations and essential re-exports (`AppState`, `run`).
- **Register `#[tauri::command]`**: Every new command must be registered in the `tauri::generate_handler![...]` list in `src-tauri/src/app/handlers.rs`.
- **State Management**: Shared application state must be attached to `AppState` in `src-tauri/src/state/`.

## Git Commits, PRs & Source Code Comments (English Only)
- **Git Commit Messages**: All commit messages must be written in **English** using Conventional Commits format (e.g., `feat(scope): ...`, `fix(scope): ...`, `refactor(scope): ...`, `docs(scope): ...`).
- **Pull Requests**: PR Titles and Descriptions must be written in **English**. Do not include `Co-Authored-By` footers/trailers.
- **Code Comments**: All code comments, explanations, and docstrings in TypeScript and Rust source files must be written in **English**.

## Refactoring & Verification Protocol
- **Always run `npx tsc --noEmit` and `oxlint` after every refactoring task**: Never rely solely on `vitest` / `npm test` because test runners do not perform full static type checking across large JSX files like `App.tsx`.
- **Grep the entire codebase before deleting or replacing state or props**: When converting tools (e.g., from modal to workspace tab) or removing state setters, always `grep_search` to verify and update all call sites synchronously (including `TitleBar`, `Sidebar`, shortcuts, and context menus).
- **Strictly differentiate similarly named features**: Never delete or mix up logic/memos between independent modules with similar names (e.g., the *Import Database* SQL dump restore tool vs the *Global Import Table* CSV/JSON/SQL feature).
