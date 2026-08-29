# SQL Ghost Text Auto-completion Specification & Design Guide

## 1. Overview
The **SQL Ghost Text Auto-completion Engine** provides instantaneous, zero-latency inline suggestions directly inside TableNova's Monaco SQL editor. Suggestions appear as subtle gray inline ghost text as the user types, and can be accepted with a single `Tab` key press (similar to GitHub Copilot / Cursor).

---

## 2. Core Pillars & Design Principles

### 2.1. 100% Offline & Zero-Latency (< 5ms)
- **Local Schema & Heuristics First**: Operates directly against in-memory catalog metadata (`catalog.ts`, `joinConditions.ts`, `sqlHistory.ts`).
- **No Remote AI Latency**: Generates suggestions synchronously without waiting for network round-trips or incurring API costs.
- **Privacy & Security**: Zero database credentials or schema structures leave the user's workstation.

### 2.2. Intelligent Heuristic Rules

```mermaid
flowchart LR
    Typing[User Typing SQL] --> Parser[Caret & Token Analyzer]
    Parser --> Router{Trigger Pattern}
    
    Router -->|JOIN table| JoinRule[1. Smart Auto-JOIN ON Foreign Keys]
    Router -->|INSERT/UPDATE/DELETE| CrudRule[2. Safe CRUD Snippets with Primary Keys]
    Router -->|SELECT ... WHERE| HistoryRule[3. History Prefix Matcher]
    Router -->|SELECT table.| ColumnRule[4. Column List Expansion]
    
    JoinRule --> GhostText[Render Inline Ghost Text]
    CrudRule --> GhostText
    HistoryRule --> GhostText
    ColumnRule --> GhostText
    
    GhostText -->|Press Tab| Accept[Insert Snippet into Editor]
    GhostText -->|Continue Typing| Dismiss[Update / Dismiss Suggestion]
```

#### Rule 1: Smart Auto-JOIN on Foreign Keys
- **Trigger**: Caret immediately follows `... JOIN <table_name> ` or `... JOIN <table_name> ON `.
- **Behavior**: Scans previously referenced tables in the query (`collectTableRefs`), checks foreign key relationships in `catalog.ts`, and suggests the exact matching condition.
- **Example**:
  - Typed: `SELECT * FROM orders JOIN users `
  - Ghost Text: `ON orders.user_id = users.id`

#### Rule 2: Safe CRUD Templates
- **INSERT INTO**:
  - Typed: `INSERT INTO users `
  - Ghost Text: `(name, email, status) VALUES ()` (Excludes auto-increment / generated primary keys).
- **UPDATE (Safe Mode Guard)**:
  - Typed: `UPDATE users `
  - Ghost Text: `SET ... WHERE id = ` (Automatically includes primary key in WHERE clause to prevent accidental full-table updates).
- **DELETE FROM (Safe Mode Guard)**:
  - Typed: `DELETE FROM users `
  - Ghost Text: `WHERE id = `

#### Rule 3: Query History Pattern Matching
- Matches current typing prefixes against successful recent queries from `sqlHistory`.
- Suggests common WHERE clauses and filter parameters previously executed by the user.

#### Rule 4: Column Expansion
- Typed: `SELECT u.` -> Suggests comma-separated list of table columns: `id, name, email, created_at`.

---

## 3. Monaco Editor Integration

### 3.1. InlineCompletionsProvider
Registered via `monaco.languages.registerInlineCompletionsProvider` for:
- `LanguageIdEnum.PG` (PostgreSQL)
- `LanguageIdEnum.MYSQL` (MySQL)
- `LanguageIdEnum.GENERIC` (SQLite & Generic SQL)

### 3.2. Settings & Preferences
Configurable in User Preferences:
- `enableGhostText: boolean` (Default: `true`)
- `ghostTextMode: 'local' | 'hybrid' | 'ai_only'` (Default: `'local'`)
- `ghostTextDelayMs: number` (Default: `0`)

---

## 4. Implementation Roadmap & Target Files

### 4.1. Core Engine Implementation
- **`src/sql/sqlInlineCompletion.ts`** [NEW]:
  - Register `monaco.languages.registerInlineCompletionsProvider` for supported dialects (`LanguageIdEnum.PG`, `LanguageIdEnum.MYSQL`, `LanguageIdEnum.GENERIC`).
  - Implement `provideLocalInlineCompletion(model, position)` to parse current line context, query `catalog.ts` for schema foreign keys and column definitions, inspect `joinConditions.ts`, and match prefix against `sqlHistory`.
  - Provide optional fallback to remote AI completion if `ghostTextMode === 'hybrid'` and local heuristics produce no candidate.

### 4.2. Monaco Editor Integration
- **`src/sql/editorOptions.ts`** [MODIFY]:
  - Configure Monaco editor settings with `inlineSuggest: { enabled: true, mode: 'subMode' }`.
- **`src/components/SqlEditor.tsx`** [MODIFY]:
  - Mount inline completions provider lifecycle on editor instantiation.
  - Display completion status badge or toggle indicator in the editor toolbar.

### 4.3. User Configuration & Preferences
- **`src/utils/aiConfig.ts` & Settings Modal** [MODIFY]:
  - Add configuration keys:
    - `enableGhostText`: toggle inline ghost text on/off.
    - `ghostTextMode`: select between `'local'` (0ms, offline schema heuristics), `'hybrid'` (local first with AI fallback), or `'ai_only'`.
    - `ghostTextDelayMs`: debounce threshold in milliseconds.

---

## 5. Key Advantages of the Local-First Architecture

1. **Instantaneous Response (< 5ms Latency)**: Runs synchronously on keystrokes with no UI lag or typing stutter.
2. **100% Privacy & Offline Security**: Database metadata, table definitions, and credentials never leave the workstation.
3. **Zero Token Cost**: Unlimited auto-completions without requiring external API keys or recurring LLM expenses.
4. **Deterministic Accuracy**: Column lists, foreign key joins, and primary key clauses always reflect actual in-memory database catalog schema.

