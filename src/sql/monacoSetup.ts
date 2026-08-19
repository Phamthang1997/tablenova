// Side-effect module: everything Monaco needs before the first editor is constructed —
// the web-worker factory, the `@monaco-editor/react` loader binding, and a font remeasure.
//
// It lives apart from `SqlEditor.tsx` because it has two consumers now: the SQL editor and
// the Redis console. Both are loaded lazily (`App.tsx` / `RedisToolTab.tsx`), so either one
// can be the first to touch Monaco, and whichever gets there first must find a configured
// `MonacoEnvironment` — otherwise Monaco falls back to fetching a worker from a URL that
// does not exist in this bundle. Importing this module is how a consumer guarantees that.
// Assignments here are idempotent, so importing it twice is harmless.
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';

// Import workers directly using Vite's ?worker loader query
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
// Worker cho monaco-sql-languages (parser + ngữ cảnh caret) theo dialect
import MySQLWorker from 'monaco-sql-languages/esm/languages/mysql/mysql.worker?worker';
import PgSQLWorker from 'monaco-sql-languages/esm/languages/pgsql/pgsql.worker?worker';
import GenericSQLWorker from 'monaco-sql-languages/esm/languages/generic/generic.worker?worker';

// Configure Monaco Environment for Vite native web workers.
//
// Only the languages this app actually opens a model for are listed: the three SQL dialects,
// plus the generic editor worker every model needs. Monaco's json/css/html/typescript workers
// are deliberately NOT imported — nothing here ever creates a model in those languages, and
// each `?worker` import emits its own chunk whether it runs or not (ts.worker alone was 5.9MB,
// the largest file in the build, against 4.2MB for Monaco itself). Their language *clients*
// still ship inside `monaco-editor`, but a client only spawns its worker once a model of that
// language exists, so none of them is ever reached. Should one somehow be, the fallback below
// hands back a plain editor worker rather than throwing.
(window as any).MonacoEnvironment = {
  getWorker(_: any, label: string) {
    if (label === 'mysql') {
      return new MySQLWorker();
    }
    if (label === 'pgsql') {
      return new PgSQLWorker();
    }
    if (label === 'genericsql') {
      return new GenericSQLWorker();
    }
    return new editorWorker();
  }
};

// Monaco đo bề rộng ký tự lúc khởi tạo. Nếu JetBrains Mono nạp xong SAU đó thì con trỏ
// sẽ lệch khỏi chữ -> đo lại khi mọi font đã sẵn sàng.
if (typeof document !== 'undefined' && (document as any).fonts?.ready) {
  (document as any).fonts.ready.then(() => monaco.editor.remeasureFonts()).catch(() => { /* bỏ qua */ });
}

// Pack monaco directly into the loader config
loader.config({ monaco });
