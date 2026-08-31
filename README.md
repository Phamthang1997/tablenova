# 🚀 TABLEGRID

<div align="center">

![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)
![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)
![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-2024_Edition-DEA584?logo=rust&logoColor=black)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)

**A modern, blazingly fast, and elegant database management client & SQL editor for PostgreSQL, MySQL, MariaDB, SQLite, and Redis with built-in MCP Server & AI Copilot.**

</div>

---

**TABLEGRID** is a high-performance, cross-platform desktop application built with **Tauri v2 + Rust** on the backend and **React 19 + TypeScript + Vite + Monaco Editor** on the frontend. It provides a fluid, intuitive, and feature-packed experience designed for developers, data engineers, and database administrators.

---

## ✨ Key Features

### 🗄️ 1. Multi-Database & Redis Support
- **PostgreSQL**: Native async driver support for advanced data types (`UUID`, `JSONB`, `NUMERIC`, `TIMESTAMPTZ`, Arrays, Composite types).
- **MySQL & MariaDB**: Native protocol integration for MySQL 8+ and MariaDB (including Sequence management).
- **SQLite**: Fast local SQLite file inspection, schema editing, and query execution.
- **Redis Key-Value & Stream Browser**:
  - Tree and flat key views with prefix filtering, TTL editor, and real-time type inspection (`String`, `Hash`, `List`, `Set`, `ZSet`, `Stream`).
  - **Redis CLI Console**: Embedded interactive command console with syntax highlighting and auto-completion.
  - **Redis Stream Panel**: Field/Value inspector with range loading and live entries.
  - **SlowLog & Metrics Dashboard**: Server latency monitor, `INFO` statistics, and client transfer tools.
  - Database index switching (`db0` – `db15`).

### 🤖 2. Embedded Model Context Protocol (MCP) Server
- **Built-in Local MCP Server**: Exposes database metadata, schema catalogs, and safe read queries to external AI clients (Claude Desktop, Cursor, Windsurf, Antigravity).
- **Enterprise Security**: Constant-time SHA-256 Bearer Token verification and strict HTTP Origin/Host filtering against DNS rebinding.

### 🧠 3. AI Assistant & SQL Copilot
- **Multi-Provider AI Integration**: Direct support for **Ollama** (Local LLMs), **Google Gemini**, **OpenAI**, **Anthropic Claude**, and **OpenRouter**.
- **Context-Aware SQL Generation**: Automatically injects current database schema and active table structures into the prompt context for accurate query generation.
- **Live Streaming & 1-Click Execution**: Real-time markdown chat streaming with instant "Run in Editor" or "Insert into Script" actions.

### 📝 4. Monaco SQL Editor Engine
- **Schema-Aware Autocomplete**: Context-aware completion for table names, columns, SQL keywords, and stored functions.
- **Query Parameters Modal**: Automatically detects `:param`, `$1`, and `?` placeholders and prompts with typed input dialogs.
- **Visual Split Views**: Single pane, Vertical split, or Horizontal split with drag-to-resize.
- **1-Click SQL Formatting**: Built-in Beautify and Minify formatters.

### 📊 5. Visual EXPLAIN & Plan Analyzer
- **Plan Diagram Flowchart**: Interactive visual node flowchart with color-coded cost severity (*Green / Amber / Red*).
- **Tree & Raw Views**: Expandable/collapsible hierarchy showing node cost, startup cost, estimated rows, and index conditions.
- **Multiple Modes**: Supports `EXPLAIN (Estimated)`, `EXPLAIN ANALYZE (Actual Execution)`, and `JSON` format inspection.

### ⚡ 6. Data Management, Migration & Comparison
- **High-Performance Data Grid**: Virtualized row rendering, inline cell editing, sorting, column filters, and smart pagination.
- **Data Generator (Mocking)**: Generates realistic mock data (Names, Emails, Dates, Regex patterns, Foreign Key constraints).
- **Database Compare & Sync**: Visual structure and data comparison between two databases with auto-generated sync DDL/DML scripts.
- **Schema Migration**: Create snapshot checkpoints, track structural changes, and export migration scripts.
- **Dump Backup & Restore**: Full database backup and restore supporting compressed `.sql.gz` files.

### 🔒 7. Enterprise Security & Transaction Controls
- **Transaction Isolation Panel**: Switch isolation levels (`Read Committed`, `Repeatable Read`, `Serializable`) with live elapsed time tracking and uncommitted close protection.
- **Safe Mode**: Read-Only lock mode to prevent accidental mutations on Production databases.
- **OS Keyring Integration**: Credentials safely encrypted in Windows Credential Manager, macOS Keychain, or Linux Secret Service.
- **SSH Tunneling (Russh)**: Connect to private databases via bastion hosts with pure-Rust SSH port forwarding.

### 🎨 8. Liquid Glass Design & Internationalization
- **Liquid Glass Theme**: Modern UI aesthetics inspired by macOS Sequoia and VisionOS with Dark and Light mode support.
- **Multi-Language (i18n)**: English and Vietnamese language support with instant switching.
- **Multi-Connection Rail (DbRail)**: Sidebar rail for managing multiple open connections concurrently with environment color tags.

---

## 🛠️ Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Desktop Shell** | [Tauri v2](https://v2.tauri.app/) (Rust) |
| **Backend Runtime** | [Tokio](https://tokio.rs/) · [SQLx](https://github.com/launchbadge/sqlx) · [Rusqlite](https://github.com/rusqlite/rusqlite) · [Redis-rs](https://github.com/redis-rs/redis-rs) |
| **Protocols & Security** | [rmcp (MCP SDK)](https://github.com/modelcontextprotocol) · [Axum](https://github.com/tokio-rs/axum) · [Russh](https://github.com/warp-tech/russh) · [Keyring-rs](https://github.com/hwchen/keyring-rs) |
| **Frontend Framework** | [React 19](https://react.dev/) · [TypeScript](https://www.typescriptlang.org/) · [Vite 8](https://vitejs.dev/) |
| **Editor & Terminal** | [Monaco Editor](https://microsoft.github.io/monaco-editor/) · [@xterm/xterm](https://xtermjs.org/) |
| **Styling & Icons** | Vanilla CSS (Liquid Glass Design Tokens) · [Lucide Icons](https://lucide.dev/) |
| **Testing & Linting** | [Vitest](https://vitest.dev/) · [Oxlint](https://oxc.rs/) |

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: `>= 18.x`
- **Rust**: `>= 1.75` (Rust 2024 Edition)
- **Package Manager**: `npm`, `pnpm`, or `yarn`

### Installation & Development

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Phamthang1997/tablenova.git
   cd tablenova
   ```

2. **Install frontend dependencies**:
   ```bash
   npm install
   ```

3. **Start in Development Mode**:
   ```bash
   npm run dev
   ```

4. **Run Unit Tests & Linting**:
   ```bash
   npm test          # Run Vitest test suites
   npx oxlint src    # Run Oxlint code analysis
   ```

5. **Build Desktop App for Production**:
   ```bash
   npm run build     # Compile frontend bundle & build native desktop executable
   ```

### ⚠️ macOS Gatekeeper Troubleshooting ("App is damaged and can't be opened")
If you download a `.dmg` release built from GitHub Actions, macOS Gatekeeper may block unsigned binaries downloaded via web browsers. To resolve this:
1. Drag `TableGrid.app` into your `/Applications` folder.
2. Open Terminal and run:
   ```bash
   sudo xattr -rd com.apple.quarantine /Applications/TableGrid.app
   ```

---

## 📁 Project Structure

```text
table/
├── src/                          # Frontend Source Code (React 19 + TypeScript)
│   ├── components/               # UI Components
│   │   ├── ai/                   # AI Assistant & Chatbot Panels
│   │   ├── redis/                # Redis Key Browser, Stream, Console & SlowLog
│   │   ├── ConnectionManager.tsx # Database Connections & Credential Dialogs
│   │   ├── DataGrid.tsx          # Virtualized Data Grid Table & In-cell Editor
│   │   ├── SqlEditor.tsx         # Monaco Editor SQL Workspace & Split Panes
│   │   ├── ExplainViewer.tsx     # Visual EXPLAIN Flowchart & Plan Analyzer
│   │   ├── DbRail.tsx            # Multi-Connection Sidebar Switcher Rail
│   │   ├── TxControl.tsx         # Transaction Isolation & Safety Toolbar
│   │   └── TerminalPanel.tsx     # Embedded Local & Remote SSH Terminal
│   ├── sql/                      # Monaco SQL Language Service & Result Formatters
│   ├── utils/                    # Tauri IPC Bridge & Helper Utilities
│   ├── i18n/                     # Internationalization (EN / VI Locales)
│   ├── App.tsx                   # Main Workspace Container Component
│   └── index.css                 # Liquid Glass Design System Tokens
├── src-tauri/                    # Backend Source Code (Rust + Tauri v2)
│   ├── src/
│   │   ├── app/                  # Tauri Handlers Registration & Run Entry
│   │   ├── database/             # PostgreSQL / MySQL / SQLite Drivers & Catalog
│   │   ├── redis_db/             # Redis Connection Session & Command Engine
│   │   ├── mcp/                  # Built-in Streamable HTTP MCP Server & Security
│   │   ├── state/                # Connection Pool Registry & App State
│   │   ├── ssh/                  # Russh Secure Port Forwarding Tunnel
│   │   ├── terminal/             # Local PTY & SSH Remote Shell Streamer
│   │   ├── credentials/          # OS Keyring Secure Storage
│   │   ├── datagen/              # Schema-Aware Mock Data Generator
│   │   ├── compare/              # Database Schema & Data Comparison
│   │   ├── stats/                # Database Server Performance Statistics
│   │   └── tx/                   # Transaction Isolation & Safe Mode Handlers
│   ├── Cargo.toml                # Rust Dependencies Manifest
│   └── tauri.conf.json           # Tauri Desktop Configuration
├── package.json
└── README.md
```

---

## 📄 License & Code of Conduct

- **Author & Creator**: **Pham Thang**
  - 📧 **Email**: [pthang888@gmail.com](mailto:pthang888@gmail.com)
  - 💼 **LinkedIn**: [thangpx](https://www.linkedin.com/in/thangpx/)
- **Copyright**: © 2026 Pham Thang and TableGrid Contributors
- **License**: Released under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
- **Code of Conduct**: Please follow our [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
