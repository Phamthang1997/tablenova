# Contributing to TABLENOVA

Thank you for your interest in contributing to **TABLENOVA**! We welcome contributions from the community to help make TABLENOVA the best cross-platform database management tool.

---

## 🚀 Getting Started

### Prerequisites

Before you start developing, ensure you have the following installed on your machine:

- **Node.js**: `>= 18.x`
- **Rust**: `>= 1.75` (Install via [rustup](https://rustup.rs/))
- **Package Manager**: `npm` (or `pnpm` / `yarn`)

### Setting Up Development Environment

1. **Fork & Clone the Repository**:
   ```bash
   git clone https://github.com/your-username/table.git
   cd table
   ```

2. **Install Frontend Dependencies**:
   ```bash
   npm install
   ```

3. **Launch Development Mode**:
   ```bash
   npm run dev
   # Or run the Windows batch script:
   .\dev-start.bat
   ```

---

## 🌿 Branching & Commit Conventions

### Branch Naming
Please create descriptive branch names using the following prefixes:
- `feature/` — New features or UI enhancements (e.g., `feature/redis-key-exporter`)
- `fix/` — Bug fixes (e.g., `fix/sqlite-connection-timeout`)
- `docs/` — Documentation updates (e.g., `docs/readme-setup`)
- `refactor/` — Code refactoring without changing functionality

### Commit Messages
Keep commit messages concise and imperative:
- `feat: add support for Redis key expiration setting`
- `fix: resolve Monaco SQL autocomplete line height shift`
- `docs: update setup steps in CONTRIBUTING.md`

---

## 🧪 Code Quality & Verification

Before submitting a Pull Request, make sure your code passes all linting, type-checking, and unit tests.

### 1. Frontend Linting & Type Checks
```bash
# Check JavaScript/TypeScript code quality with oxlint
npx oxlint

# Run TypeScript type check
npx tsc --noEmit
```

### 2. Frontend Unit Tests
```bash
# Run Vitest test suite
npm run test
```

### 3. Rust Backend Linting
```bash
cd src-tauri
cargo clippy --all-targets -- -D warnings
```

---

## 📥 Submitting a Pull Request (PR)

1. Push your branch to your forked repository:
   ```bash
   git push origin feature/your-feature-name
   ```
2. Open a Pull Request against the `main` branch of the official repository.
3. Fill out the **Pull Request Template** completely.
4. Ensure all CI checks (Linter, Typecheck, Cargo Clippy) pass cleanly.

---

## 📄 License

By contributing to TABLENOVA, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
