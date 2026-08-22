import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { Play, ListChecks } from 'lucide-react';
import { dbHelper } from '../../utils/dbHelper';
import { SQL_EDITOR_OPTIONS } from '../../sql/editorOptions';
import { defineSqlThemes, sqlThemeName } from '../../sql/theme';
import { COMMANDS } from './commandHelp';
import { REDIS_LANG_ID, registerRedisLanguage } from './redisLanguage';
import { commandAtLine, splitRedisCommands } from './redisScript';
// Worker factory + loader binding. This module is lazy-loaded and may well be the first thing
// in the app to touch Monaco, so it configures the environment itself rather than relying on
// `SqlEditor` having been imported first.
import '../../sql/monacoSetup';

interface ConsoleProps {
  /** localStorage scope for the buffer — the server, never `dbName`. */
  storageScope: string;
  theme: 'dark' | 'light';
  onError: (msg: string) => void;
  /**
   * `SELECT n` gõ trong console. Kèm `connId` vì backend KHÔNG đổi db của kết nối này — nó phân
   * giải ra kết nối của db đó và báo lại (§2.2); người nhận phải chuyển workspace sang id ấy.
   */
  onSelectedDb: (index: number, connId?: string) => void;
}

const QUICK_CMDS = ['PING', 'INFO', 'DBSIZE', 'CLIENT LIST', 'CONFIG GET maxmemory'];

interface LogEntry {
  cmd: string;
  out: string;
  ok: boolean;
  /** Dòng thông báo của hệ thống (đã chuyển db…), không phải kết quả của server. */
  note?: boolean;
}

/**
 * CLI console — một khung Monaco nhiều dòng, không phải một ô nhập một dòng.
 *
 * Đổi hình vì ô một dòng ép người dùng vào đúng một thao tác: gõ một lệnh, Enter, quên nó đi. Cái
 * thực tế người ta làm với `redis-cli` là giữ lại một nhúm lệnh và chạy lại chúng — dò một key, sửa
 * TTL, kiểm lại. Một buffer làm được điều đó mà không cần thêm tính năng nào; nó cũng thay luôn
 * lịch sử ↑/↓ cũ, vì bản thân buffer đã là lịch sử và còn sửa được.
 *
 * Dùng lại nguyên bộ Monaco của phía SQL — `SQL_EDITOR_OPTIONS`, hai theme — nên phím tắt, cỡ chữ,
 * hành vi gợi ý giống hệt tab truy vấn. Riêng ngôn ngữ là của Redis (`redisLanguage.ts`).
 *
 * Hai lớp lệnh vẫn do backend từ chối chứ không phải ở đây — ghi khi đang chỉ đọc, và lệnh chiếm
 * dụng connection dùng chung (`SUBSCRIBE`, `MONITOR`, `BLPOP`…) — nên thông báo người dùng thấy
 * đúng là thông báo từ biên IPC, không phải một phán đoán thứ hai của UI.
 */
export const Console: React.FC<ConsoleProps> = ({ storageScope, theme, onError, onSelectedDb }) => {
  const { t } = useTranslation();
  const bufKey = `tf_redis_cli_buf_${storageScope}`;
  const legacyHistoryKey = `tf_redis_cli_history_${storageScope}`;

  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  // Vị trí con trỏ, hiển thị ở thanh hành động như khung SQL. State chứ không đọc thẳng từ Monaco:
  // nó phải vẽ lại mỗi lần con trỏ nhích, và đó chính là việc của state.
  const [pos, setPos] = useState({ line: 1, col: 1 });
  /** Chiều cao editor do người dùng kéo, tính bằng px. `null` = chưa kéo, dùng tỉ lệ mặc định. */
  const [editorH, setEditorH] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const editorBoxRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  /**
   * Nội dung ban đầu.
   *
   * Lần đầu chạy bản mới thì chưa có buffer, nhưng có thể có lịch sử ↑/↓ của bản cũ — nạp nó vào
   * làm buffer thay vì bỏ mặc trong localStorage. Người dùng không mất những lệnh đã gõ chỉ vì
   * chỗ chứa chúng đổi hình.
   */
  const initialRef = useRef<string | null>(null);
  if (initialRef.current === null) {
    let buf = '';
    try {
      buf = localStorage.getItem(bufKey) ?? '';
      if (!buf) {
        const raw = localStorage.getItem(legacyHistoryKey);
        if (raw) buf = (JSON.parse(raw) as string[]).join('\n');
      }
    } catch { /* localStorage hỏng -> bắt đầu rỗng */ }
    initialRef.current = buf;
  }

  useEffect(() => { registerRedisLanguage(); defineSqlThemes(); }, []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  /** Đọc thẳng từ Monaco, không qua state — giống `getPaneSql()` của SqlEditor. */
  const bufferText = () => editorRef.current?.getValue() ?? '';

  const persist = useCallback(() => {
    try { localStorage.setItem(bufKey, bufferText()); } catch { /* quota */ }
  }, [bufKey]);

  /**
   * Chạy một dãy lệnh theo thứ tự.
   *
   * **Dừng ở `SELECT n`** thay vì chạy tiếp. Backend không đổi db của kết nối này — nó phân giải ra
   * kết nối của `dbN` và báo lại (§2.2) — nên các lệnh phía sau, nếu chạy tiếp, sẽ chạy trên db
   * CŨ trong khi người dùng viết chúng cho db mới. Chạy đúng một nửa ý định là tệ hơn dừng lại và
   * nói ra.
   */
  const runCommands = useCallback(async (cmds: string[]) => {
    if (cmds.length === 0 || running) return;
    setRunning(true);
    try {
      for (let i = 0; i < cmds.length; i++) {
        const command = cmds[i];
        const res = await dbHelper.redisExecuteCmd(command);
        const out = res.success ? JSON.stringify(res.result, null, 2) : `(error) ${res.error}`;
        if (!res.success && res.error) onError(res.error);
        setLog((prev) => [...prev, { cmd: command, out, ok: !!res.success }]);

        if (res.selectedDb != null) {
          onSelectedDb(res.selectedDb, res.switchDb?.connId);
          const left = cmds.length - i - 1;
          if (left > 0) {
            setLog((prev) => [...prev, {
              cmd: '',
              out: t('redis.cliStoppedAtSelect', { db: res.selectedDb, n: left }),
              ok: true,
              note: true,
            }]);
          }
          break;
        }
      }
    } finally {
      setRunning(false);
    }
  }, [running, onError, onSelectedDb, t]);

  /** Ctrl+Enter: lệnh dưới con trỏ. */
  const runCurrent = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const line = ed.getPosition()?.lineNumber ?? 1;
    const cmd = commandAtLine(ed.getValue(), line);
    if (!cmd) { onError(t('redis.cliNothingToRun')); return; }
    void runCommands([cmd.text]);
  }, [runCommands, onError, t]);

  /** Ctrl+Shift+Enter: cả buffer. */
  const runAll = useCallback(() => {
    const cmds = splitRedisCommands(bufferText()).map((c) => c.text);
    if (cmds.length === 0) { onError(t('redis.cliNothingToRun')); return; }
    void runCommands(cmds);
  }, [runCommands, onError, t]);

  // Hai handler được gọi từ phím tắt của Monaco, vốn giữ closure của lần mount đầu — đọc qua ref
  // để phím tắt luôn gọi bản mới nhất. Cùng cách `SqlEditor` xử lý action của nó.
  const runHintRef = useRef('');
  runHintRef.current = t('redis.cliRunThisLine');

  const runCurrentRef = useRef(runCurrent);
  runCurrentRef.current = runCurrent;
  const runAllRef = useRef(runAll);
  runAllRef.current = runAll;

  /** Tháo listener kéo nếu tab bị đóng giữa chừng. */
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  /**
   * Kéo đường kẻ giữa thanh hành động và vùng kết quả để đổi chiều cao editor.
   *
   * Nghe `mousemove`/`mouseup` trên `window` chứ không trên chính đường kẻ: kéo nhanh thì con trỏ
   * rời khỏi dải 4px trước khi trình duyệt kịp bắn sự kiện, và khi đó thao tác kéo đứt giữa chừng.
   */
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const startY = e.clientY;
    const startH = editorBoxRef.current?.clientHeight ?? 220;

    const onMove = (ev: MouseEvent) => {
      const root = rootRef.current;
      // Chừa tối thiểu 120px cho vùng kết quả và 80px cho editor — kéo hết cỡ mà một trong hai
      // biến mất thì không còn đường kéo ngược lại.
      const maxH = root ? root.clientHeight - 120 : window.innerHeight - 200;
      setEditorH(Math.max(80, Math.min(maxH, startH + ev.clientY - startY)));
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Monaco đo lại ngay thay vì chờ vòng `automaticLayout` kế tiếp.
      editorRef.current?.layout();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    dragCleanupRef.current = onUp;
  };

  const onMount = (ed: monaco.editor.IStandaloneCodeEditor) => {
    editorRef.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCurrentRef.current());
    ed.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
      () => runAllRef.current(),
    );

    // Bấm mũi tên ở lề = chạy đúng dòng đó. Đặt con trỏ trước rồi mới chạy, để `runCurrent` và cú
    // bấm này không thể bất đồng về "dòng nào".
    ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      if (!e.target.position) return;
      ed.setPosition(e.target.position);
      runCurrentRef.current();
    });

    // Tô sáng dòng mà Ctrl+Enter sẽ chạy. Rẻ hơn hẳn bản SQL — ở đây "câu lệnh" luôn là một dòng,
    // nên không phải mask chuỗi/chú thích để tìm ranh giới; chỉ cần biết con trỏ ở dòng nào.
    const decorations = ed.createDecorationsCollection([]);
    const refresh = () => {
      const model = ed.getModel();
      const pos = ed.getPosition();
      if (!model || !pos) return;
      const text = model.getValue();
      const cmd = commandAtLine(text, pos.lineNumber);
      if (!cmd) { decorations.set([]); return; }
      const items: monaco.editor.IModelDeltaDecoration[] = [{
        range: new monaco.Range(cmd.line, 1, cmd.line, 1),
        options: {
          glyphMarginClassName: 'sql-run-glyph',
          glyphMarginHoverMessage: { value: runHintRef.current },
        },
      }];
      // Chỉ tô nền khi có nhiều hơn một lệnh — một lệnh duy nhất thì tô cả nó là vô nghĩa.
      if (splitRedisCommands(text).length > 1) {
        items.push({
          range: new monaco.Range(cmd.line, 1, cmd.line, model.getLineMaxColumn(cmd.line)),
          options: { isWholeLine: true, className: 'sql-current-stmt' },
        });
      }
      decorations.set(items);
    };
    ed.onDidChangeCursorPosition((e) => {
      setPos({ line: e.position.lineNumber, col: e.position.column });
      refresh();
    });
    ed.onDidChangeModelContent(refresh);
    refresh();

    ed.focus();
  };

  /** Lệnh nhanh: chèn thành một dòng mới ở cuối buffer rồi chạy. */
  const runQuick = (q: string) => {
    const ed = editorRef.current;
    if (ed) {
      const text = ed.getValue();
      const next = text && !text.endsWith('\n') ? `${text}\n${q}` : `${text}${q}`;
      ed.setValue(next);
      const last = ed.getModel()?.getLineCount() ?? 1;
      ed.setPosition({ lineNumber: last, column: q.length + 1 });
      persist();
    }
    void runCommands([q]);
  };

  return (
    <div className="redis-console" ref={rootRef}>
      {/* Thứ tự theo đúng khung truy vấn SQL: editor -> thanh hành động -> tab kết quả -> vùng kết
          quả -> dòng trạng thái. Bản trước đặt toàn bộ nút LÊN TRÊN editor, nên nút Chạy nằm xa
          chỗ mắt đang nhìn (dòng lệnh đang gõ) và vùng kết quả thì không có gì nhận dạng. */}
      <div
        className="redis-cli-editor"
        ref={editorBoxRef}
        // Chỉ ghi đè khi người dùng đã kéo; chưa kéo thì để tỉ lệ mặc định trong CSS quyết định.
        style={editorH != null ? { flex: '0 0 auto', height: editorH } : undefined}
      >
        <Editor
          height="100%"
          language={REDIS_LANG_ID}
          theme={sqlThemeName(theme)}
          defaultValue={initialRef.current}
          onChange={persist}
          onMount={onMount}
          options={{ ...SQL_EDITOR_OPTIONS, lineNumbersMinChars: 2 }}
        />
      </div>

      <div className="redis-cli-actionbar">
        <span className="redis-cli-pos">
          {t('redis.cliPosition', { line: pos.line, col: pos.col })}
        </span>
        <span className="redis-value-meta">{t('redis.commandsKnown', { n: COMMANDS.length })}</span>
        <div className="redis-keylist-spacer" />
        {QUICK_CMDS.map((q) => (
          <button key={q} onClick={() => runQuick(q)} className="redis-pill" disabled={running}>{q}</button>
        ))}
        <button className="btn btn-secondary redis-value-save" onClick={runAll} disabled={running}>
          <ListChecks size={11} /> {t('redis.cliRunAll')}
        </button>
        <button className="btn btn-primary redis-value-save" onClick={runCurrent} disabled={running}>
          <Play size={11} /> {t('redis.runCommand')}
        </button>
      </div>

      <div
        className={`redis-cli-resizer${dragging ? ' dragging' : ''}`}
        onMouseDown={startDrag}
        title={t('redis.cliResizeHint')}
      />

      <div className="redis-cli-result-head">
        <span className="redis-cli-result-tab">{t('redis.cliResults')}</span>
        {log.length > 0 && (
          <span className="redis-value-meta">{t('redis.cliResultCount', { n: log.length })}</span>
        )}
        <div className="redis-keylist-spacer" />
        <button className="redis-ghost-btn" onClick={() => setLog([])} disabled={log.length === 0}>
          {t('redis.clearLog')}
        </button>
      </div>

      <div ref={logRef} className="redis-log-box flush">
        {log.length === 0 ? (
          <div className="redis-cli-result-empty">{t('redis.cliResultEmpty')}</div>
        ) : log.map((l, i) => (
          <div key={i} className="redis-console-entry">
            {l.cmd && <div className="redis-console-echo">&gt; {l.cmd}</div>}
            <pre className={`redis-console-out${l.ok ? '' : ' err'}${l.note ? ' note' : ''}`}>{l.out}</pre>
          </div>
        ))}
      </div>

      <div className="redis-cli-status">
        {running ? t('redis.cliStatusRunning') : t('redis.consoleHint')}
      </div>
    </div>
  );
};
