# Interactive ER Diagram Visualizer (TableNova)

The **Interactive ER Diagram Visualizer** provides a modern, canvas-based Entity-Relationship diagram designed for PostgreSQL, MySQL, and SQLite databases within TableNova.

---

## 1. Key Highlights & Features

### 1.1. Automatic Hierarchical DAG Layout
- Arranges database tables into top-to-bottom or left-to-right dependency hierarchies based on foreign key relationships.
- Automatically calculates custom node heights depending on visible columns and detail modes.
- Supports isolated node grids for standalone tables without relationships.

### 1.2. Multiple Detail View Modes
- **Full**: Displays table header, primary keys, foreign keys with reference badges, all regular columns, and exact data types.
- **Keys Only**: Shows only PK and FK columns for high-density overview of complex schemas.
- **Compact**: Shows top primary columns and key relations for quick schema browsing.

### 1.3. Smooth Bezier Relationship Lines
- Computes cubic Bezier curves (`M ... C ...`) connecting foreign key sockets directly to target primary key sockets.
- Interactive hover effects highlight source table, target table, and relation paths with glowing accent colors while dimming unrelated entities.

### 1.4. Navigation, Search & Minimap
- **Infinite Canvas**: Smooth drag panning, scroll-wheel zooming (10% to 250%), and fit-to-view calculation.
- **Real-Time Search**: Instant filtering and highlighting matching table names and column names.
- **Radar Minimap**: Real-time viewport radar at bottom-right for quick navigation across large databases.

### 1.5. Multi-Format Exporting
- **PNG (High-Resolution)**: Generates crystal-clear raster images for presentations and documentation.
- **Copy Image to Clipboard**: 1-click clipboard image export.
- **DBML Export**: Compatible with [dbdiagram.io](https://dbdiagram.io).
- **DDL SQL Schema Export**: Standard SQL CREATE TABLE statements with foreign keys.

---

## 2. Technical Architecture

```
src/components/er/
├── ERDiagramTab.tsx        # Main tab view integrating canvas, toolbar, minimap, and state
├── ERDiagramView.tsx       # SVG Canvas renderer with zoom/pan gesture handlers
├── ERTableNode.tsx         # Virtualized table card node component
├── ERRelationshipLine.tsx  # SVG Bezier relationship curve with hitboxes
├── ERToolbar.tsx           # Floating centered control bar (search, modes, zoom, export)
├── ERMinimap.tsx           # Radar minimap navigation widget
├── erLayoutEngine.ts       # Topological DAG hierarchical layout algorithm
├── erExportHelper.ts       # Exporters (PNG, Clipboard, DBML, SQL DDL)
├── erPersistence.ts        # Local coordinate cache persistence per connection/database
└── erTypes.ts              # TypeScript type definitions
```

---

## 3. Development & Testing
- Unit tests: `src/components/er/__tests__/erDiagram.test.ts` (8 test suites covering layout computation, socket calculation, Bezier math, and DBML/SQL export).
- Styling: Zero inline CSS, all styles defined in `src/index.css`.
