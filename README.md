# 🚀 TABLENOVA

> **A modern, blazingly fast, and elegant database management client & SQL editor for PostgreSQL, MySQL, SQLite, and Redis.**

**TABLENOVA** is a high-performance cross-platform desktop application built with **Tauri v2 + Rust** on the backend and **React 19 + TypeScript + Vite + Monaco Editor** on the frontend. It provides a fluid, intuitive, and feature-packed experience designed for developers and database administrators.

---

## ✨ Key Features

### 🗄️ 1. Multi-Database & Redis Support
- **PostgreSQL**: Native async support for advanced data types (UUID, JSONB, Numeric, Chrono Timestamps, Arrays).
- **MySQL & MariaDB**: Native driver integration for MySQL 8+ and MariaDB.
- **SQLite**: Blazingly fast local SQLite file management and query engine.
- **Redis Key-Value Store**: Built-in **Redis Key Browser** with key filtering, TTL management, data type inspection (`String`, `Hash`, `List`, `Set`, `ZSet`), database index switching (`db0` – `db15`), and server metrics (`INFO`).
- **Enterprise Security**: SSL/TLS encryption, SSH Tunneling (Russh), AWS IAM Authentication, and OS Keyring integration for safe credential storage.

### 📝 2. Monaco SQL Editor Engine
- **Schema-Aware Autocomplete**: Real-time context-aware completion for table names, column names, SQL keywords, and database functions.
- **Query Parameters**: Supports `:param_name`, `$1`, and `?` placeholder syntaxes with automatic parameter prompt dialogs.
- **1-Click SQL Formatting**: Built-in **Beautify SQL** and **Minify SQL** formatters.
- **Flexible Split Views**: Single pane, Vertical split (Left/Right), or Horizontal split (Top/Bottom) with draggable resizers.

### 📊 3. Visual EXPLAIN & Plan Analyzer
- **Plan Diagram View**: Interactive node flowchart visualizer with color-coded cost severity (*Green / Orange / Red*).
- **Tree View**: Detailed expandable/collapsible hierarchy showing operation types, cost, estimated rows, and index usage.
- **Raw View**: Copyable original text output for exact query execution plan inspection.
- **Multiple Modes**: Supports `EXPLAIN (Estimated)`, `EXPLAIN ANALYZE (Actual Execution)`, and `JSON` format output.

### ⚡ 4. Data Grid & Management Tools
- High-performance data grid with configurable pagination (10, 20, 50, 100, 500+ rows/page).
- Direct cell editing, column sorting, filtering, and table structure management.
- Data export in **CSV**, **JSON**, or **SQL Dump** format.
- **Database Backup & Restore**: Full database dump export/import supporting compressed `.sql.gz` files.
- **Schema Migration**: Inspect and compare table structures and indexes.

### 💻 5. Embedded Terminal & SSH Integration
- **Interactive Terminal**: Integrated local shell and remote SSH terminal powered by `@xterm/xterm`.
- **SSH Tunneling**: Securely connect to databases inside private VPCs or remote servers via SSH port forwarding.

### 🎨 6. Modern Liquid Glass Aesthetics
- Premium Dark and Light modes with macOS Sequoia / VisionOS inspired Liquid Glass design system.
- Dynamic smart dropdowns automatically calculated to fit screen boundaries.

---

## 🛠️ Tech Stack

### Backend (Rust / Tauri v2)
- **Tauri v2**: Lightweight, secure, and fast desktop application framework.
- **SQLx & Rusqlite**: Async connection pooling for PostgreSQL, MySQL, and SQLite.
- **Russh**: Pure-Rust SSH protocol implementation for secure tunneling and remote PTY terminal sessions.
- **Tokio**: High-performance asynchronous runtime.
- **Keyring**: OS-native credential storage (Windows Credential Manager, macOS Keychain, Linux Secret Service).

### Frontend (React / TypeScript)
- **React 19 & TypeScript 6**: Modern component-driven UI architecture.
- **Vite 8**: High-speed frontend build tool and dev server.
- **Monaco Editor**: VS Code's editor engine for SQL writing and syntax highlighting.
- **@xterm/xterm**: Full PTY terminal emulator component.
- **Lucide React**: Modern icon set.

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: `>= 18.x`
- **Rust**: `>= 1.75`
- **Package Manager**: `npm`, `yarn`, or `pnpm`

### Installation & Run

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-username/table.git
   cd table
   ```

2. **Install frontend dependencies**:
   ```bash
   npm install
   ```

3. **Start in Development Mode**:
   ```bash
   npm run dev
   # Or run the Windows batch starter script:
   .\dev-start.bat
   ```

4. **Build Production Desktop Package**:
   ```bash
   npm run build
   ```

---

## 📁 Project Structure

```text
table/
├── src/                          # Frontend Source Code (React 19 + TS)
│   ├── components/               # UI Components
│   │   ├── ConnectionManager.tsx # Connection Manager Modal & Profile List
│   │   ├── DataGrid.tsx          # Data Grid Table Viewer & Cell Editor
│   │   ├── SqlEditor.tsx         # Monaco SQL Editor & Query Executor
│   │   ├── RedisBrowser.tsx      # Redis Key-Value Inspector & Manager
│   │   ├── ExplainViewer.tsx     # EXPLAIN Plan Visualizer Tabs
│   │   ├── ExplainDiagramView.tsx# Flowchart Plan Diagram
│   │   ├── TerminalPanel.tsx     # Embedded Local & SSH Terminal (Xterm)
│   │   └── StructureViewer.tsx   # Table Schema & Index Inspector
│   ├── utils/
│   │   ├── dbHelper.ts           # Tauri IPC Bridge for Database Operations
│   │   └── explainHelper.ts      # Query Execution Plan Parser
│   ├── App.tsx                   # Main Application Component
│   └── index.css                 # CSS Design System & Theme Tokens
├── src-tauri/                    # Backend Source Code (Rust + Tauri v2)
│   ├── src/
│   │   ├── main.rs               # Desktop App Entrypoint
│   │   ├── lib.rs                # Tauri IPC Command Handlers & App State
│   │   ├── database.rs           # SQL Connection Pool, Query & Export Logic
│   │   ├── redis_db.rs           # Redis Connection & Key Browser Handler
│   │   ├── ssh_tunnel.rs         # SSH Port Forwarding Tunnel
│   │   ├── ssh_terminal.rs       # Remote SSH PTY Terminal Streaming
│   │   ├── local_terminal.rs     # Embedded Local PTY Shell Session
│   │   ├── aws_iam.rs            # AWS IAM Authentication Token Provider
│   │   └── secret_store.rs       # OS Keyring Secure Password Storage
│   ├── Cargo.toml                # Rust Dependencies Manifest
│   └── tauri.conf.json           # Tauri Desktop App Configuration
├── package.json
└── README.md
```

---

## 📄 License & Publisher

- **Publisher / Author**: **MeoMeo**
  - 📧 **Email**: [pthang888@gmail.com](mailto:pthang888@gmail.com)
  - 💼 **LinkedIn**: [thangpx](https://www.linkedin.com/in/thangpx/)
- **Copyright**: © 2026 MeoMeo · TABLENOVA
- **License**: Released under the [MIT License](LICENSE).
