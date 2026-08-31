# Contributing to TABLEGRID

Thank you for your interest in contributing to **TABLEGRID**! We welcome contributions from the community to help make TABLEGRID the best modern cross-platform database management tool.

---

## 📜 Code of Conduct

All contributors and participants are expected to follow our [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Please report any unacceptable behavior to [pthang888@gmail.com](mailto:pthang888@gmail.com).

---

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed on your development machine:

- **Node.js**: `>= 18.x`
- **Rust**: `>= 1.85` (Rust 2024 Edition supported, install via [rustup.rs](https://rustup.rs/))
- **Package Manager**: `npm` (or `pnpm` / `yarn`)
- **Git**

### Setting Up the Environment

1. **Fork & Clone the Repository**:
   ```bash
   git clone https://github.com/Phamthang1997/tablenova.git
   cd tablenova
   ```

2. **Install Frontend Dependencies**:
   ```bash
   npm install
   ```

3. **Launch Desktop Development Mode**:
   ```bash
   npm run dev
   # Or run the Windows batch script:
   .\dev-start.bat
   ```

---

## 🏗️ Architecture & Coding Guidelines

### Frontend (React 19 + TypeScript + CSS)
- **No Inline CSS**: Never use inline styles (`style={{ ... }}`) for static design. All UI styling must use CSS utility and component classes defined in `src/index.css`.
  - *Exception*: Inline styles are only permitted for dynamic runtime data (e.g. mouse drag coordinates, progress bar percentage, custom user color picker values).
- **React Compiler & Hooks Compliance**:
  - Do not mutate or read `useRef.current` directly in component render bodies. Synchronize refs inside `useEffect`.
  - Avoid synchronous `setState` inside `useEffect` if it causes cascading renders; use `queueMicrotask(() => setState(...))` or derive state during render.
- **Internationalization (i18n)**: Wrap user-facing strings with `t('namespace.key')` in `src/i18n/locales/`.

### Backend (Rust / Tauri v2)
- **Domain-Driven Directory Structure**:
  - Keep domain logic organized in its dedicated folder under `src-tauri/src/<domain>/` (`database`, `redis_db`, `mcp`, `ssh`, `terminal`, `credentials`, `datagen`, `compare`, `stats`, `tx`, `state`, `app`).
  - Do not place raw business logic directly in `src-tauri/src/lib.rs` or `main.rs`.
- **Registering Tauri Commands**:
  - All new `#[tauri::command]` functions must be registered in the handler list inside `src-tauri/src/app/handlers.rs`.
- **State Management**: Shared application state must be stored in `AppState` under `src-tauri/src/state/`.

---

## 🌿 Branching & Commit Conventions

### Branch Naming
Create descriptive branch names using standard prefixes:
- `feat/` — New features or major enhancements (e.g., `feat/redis-stream-viewer`)
- `fix/` — Bug fixes (e.g., `fix/sqlite-transaction-rollback`)
- `docs/` — Documentation updates (e.g., `docs/mcp-setup-guide`)
- `refactor/` — Code refactoring without changing behavior
- `test/` — Adding or updating test suites

### Conventional Commits
Please use conventional commit messages:
```text
feat(redis): add real-time stream field inspector
fix(editor): prevent monaco cursor jump on query format
refactor(database): decouple connection pool from catalog inspector
docs: update contribution guidelines for Rust 2024
```

---

## 🧪 Quality Assurance & Pre-Commit Verification

Before submitting a Pull Request, ensure your code passes all checks:

### 1. Frontend Linting & Zero-Warning Policy
```bash
# Check code with Oxlint (must report 0 warnings and 0 errors)
npx oxlint src
```

### 2. Frontend Unit Tests & Production Build
```bash
# Run Vitest test suites (all 725+ tests must pass)
npm test

# Verify TypeScript compilation and Vite build
npm run build-frontend
```

### 3. Rust Backend Checks & Tests
```bash
cd src-tauri

# Run Rust unit tests
cargo test

# Run Rust linter
cargo clippy --all-targets -- -D warnings
```

---

## 📥 Submitting a Pull Request (PR)

1. Push your changes to your feature branch:
   ```bash
   git push origin feat/your-feature-name
   ```
2. Open a Pull Request against the `main` branch of `Phamthang1997/tablenova`.
3. Provide a clear description of the problem solved, changes made, and screenshots/GIFs for UI changes.
4. Ensure all automated CI checks pass.

---

## 📄 License

By contributing to **TABLENOVA**, you agree that your contributions will be licensed under the project's **[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)**.
