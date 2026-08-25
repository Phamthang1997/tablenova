import React, { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { X, TerminalSquare, PictureInPicture2, PanelBottom, FileSearch, ScrollText, Maximize2, Minimize2, ExternalLink, Copy, FolderOpen, RefreshCw, Play, Eraser } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import type { DbConnectionConfig, SshTerminalMessage } from '../utils/dbHelper';
import { openTerminalWindow } from '../utils/terminalWindow';
import { ConfirmDialog } from './ConfirmDialog';

interface TerminalPanelProps {
  /** Kết nối mà component này thao tác lên. Truyền tường minh, không đọc id ambient (§4.1). */
  connId: string;
  config: DbConnectionConfig;
  profileName?: string;
  onClose: () => void;
  floating?: boolean;          // true = cửa sổ nổi; false = ghim trong tab
  active?: boolean;            // (chế độ ghim) tab này có đang active không -> quyết định hiện/ẩn
  onToggleFloat?: () => void;  // có -> hiện nút pop-out/dock
  inOwnWindow?: boolean;       // đang chạy trong cửa sổ OS riêng -> ẩn nút "Cửa sổ mới" + lấp đầy
  // Có hiện nút X trên header không. Bên nào đã có đường đóng khác (terminal mở
  // dưới dạng tab -> X trên tab) thì truyền false để header khỏi trùng nút.
  closable?: boolean;
}

// Terminal thông minh: profile có SSH -> shell từ xa; ngược lại -> shell máy cục bộ.
// Hai mode display:
//   - Ghim (docked): lấp đầy vùng nội dung của tab, chỉ hiện khi tab active (ẩn = display:none,
//     KHÔNG unmount -> phiên PTY sống khi chuyển tab).
//   - Nổi (floating): cửa sổ nổi kéo di chuyển được, hiện bất kể tab nào đang active.
export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  connId,
  config,
  profileName,
  onClose: _onClose,
  floating = false,
  active = true,
  onToggleFloat,
  inOwnWindow = false,
  closable: _closable = true,
}) => {
  const { t } = useTranslation();
  // The shell-opening effect runs once per session (deps: [epoch]) and writes into
  // the xterm buffer from its callbacks. Reading `t` directly would put it in the
  // dependency graph, so switching language would tear down the live PTY.
  const tRef = useRef(t);
  tRef.current = t;

  const containerRef = useRef<HTMLDivElement>(null);
  // crypto.randomUUID thay cho Math.random: sessionId là định danh phiên gửi xuống backend,
  // không nên đoán trước được (cũng loại luôn khả năng trùng id).
  const sessionIdRef = useRef<string>(`term_${crypto.randomUUID()}`);
  const apiRef = useRef<{ input: (d: string) => void } | null>(null);
  const termRef = useRef<Terminal | null>(null);

  const [pos, setPos] = useState({ x: 240, y: 90 });
  const [maximized, setMaximized] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const [logMenu, setLogMenu] = useState(false);
  const [logPaths, setLogPaths] = useState<{ label: string; path: string }[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  // Lý do dò log thất bại, để hiện trong menu thay vì báo chung "không tìm thấy".
  const [detectError, setDetectError] = useState<string | null>(null);
  // Phiên shell còn sống hay không. Trước đây trạng thái này KHÔNG được lưu: khi
  // shell chết, panel chỉ in "[Đã ngắt kết nối]" rồi mọi thao tác log vẫn gọi
  // api.input() vào phiên đã đóng -> bấm gì cũng không có phản hồi.
  const [alive, setAlive] = useState(true);
  // Tăng lên để mở lại phiên shell (dùng làm dependency của effect khởi tạo).
  const [epoch, setEpoch] = useState(0);

  // Ô run SQL in panel
  const [sqlBar, setSqlBar] = useState(false);
  const [sqlText, setSqlText] = useState('');
  const [sqlBusy, setSqlBusy] = useState(false);
  const [sqlHistory, setSqlHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  // Thanh thông báo của app, đặt ngoài buffer terminal để shell không vẽ chồng lên.
  const [banner, setBanner] = useState<{ text: string; kind: 'info' | 'ok' | 'err' } | null>(null);
  const bannerTimer = useRef<number | null>(null);
  const [setupMenu, setSetupMenu] = useState(false);
  /** Enable-logging request waiting for confirmation — see handleEnableLog. */
  const [enableLogPrompt, setEnableLogPrompt] = useState<{ kind: string; message: string } | null>(null);

  // Nguồn log: chạy lệnh tail thẳng (local), bọc qua ssh (VM), hay docker exec/logs (Docker).
  const [logSource, setLogSource] = useState<'local' | 'ssh' | 'docker'>(() => (localStorage.getItem('term_log_source') as any) || 'local');
  const [sshTarget, setSshTarget] = useState(() => localStorage.getItem('term_ssh_target') || '');
  const [dockerContainer, setDockerContainer] = useState(() => localStorage.getItem('term_docker_container') || '');
  useEffect(() => { localStorage.setItem('term_log_source', logSource); }, [logSource]);
  useEffect(() => { localStorage.setItem('term_ssh_target', sshTarget); }, [sshTarget]);
  useEffect(() => { localStorage.setItem('term_docker_container', dockerContainer); }, [dockerContainer]);
  // Dọn timer của thanh thông báo khi unmount, tránh setState sau khi component đã gỡ.
  useEffect(() => () => { if (bannerTimer.current) window.clearTimeout(bannerTimer.current); }, []);

  const useSsh = !!(config.sshEnabled && config.sshHost);

  useEffect(() => {
    if (!containerRef.current) return;
    // Mỗi lần kết nối lại phải dùng sessionId mới: backend giữ phiên theo id, dùng
    // lại id cũ (đã bị đóng) sẽ mở không được.
    if (epoch > 0) {
      sessionIdRef.current = `term_${crypto.randomUUID()}`;
    }
    const sessionId = sessionIdRef.current;
    setAlive(true);

    const api = useSsh
      ? {
          open: (c: number, r: number, cb: (m: SshTerminalMessage) => void) =>
            dbHelper.openSshTerminal(config, sessionId, c, r, cb),
          input: (d: string) => dbHelper.sendSshInput(sessionId, d),
          resize: (c: number, r: number) => dbHelper.resizeSshTerminal(sessionId, c, r),
          close: () => dbHelper.closeSshTerminal(sessionId),
        }
      : {
          open: (c: number, r: number, cb: (m: SshTerminalMessage) => void) =>
            dbHelper.openLocalTerminal(sessionId, c, r, cb),
          input: (d: string) => dbHelper.sendLocalInput(sessionId, d),
          resize: (c: number, r: number) => dbHelper.resizeLocalTerminal(sessionId, c, r),
          close: () => dbHelper.closeLocalTerminal(sessionId),
        };
    apiRef.current = { input: api.input };

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      theme: { background: '#1c1c1e', foreground: '#e5e5e7' },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    const doFit = () => { try { fit.fit(); } catch { /* ignore */ } };
    // Fit NGAY (đồng bộ) trước khi mở PTY: để số cột/dòng của PTY khớp xterm ngay từ đầu,
    // tránh ConPTY ngắt dòng theo 80 cột trong khi xterm rộng hơn -> chữ rơi sai cột/lộn xộn.
    doFit();

    const dataSub = term.onData((d) => { void api.input(d); });
    const resizeSub = term.onResize(({ cols, rows }) => { void api.resize(cols, rows); });

    let disposed = false;

    api
      .open(term.cols, term.rows, (msg) => {
        if (disposed) return;
        if (msg.type === 'data' && msg.bytes) {
          term.write(new Uint8Array(msg.bytes));
        } else if (msg.type === 'exit') {
          // '\x1b[2K' xoá sạch dòng hiện tại trước khi in, tránh ghi đè lên dòng
          // shell đang in dở (chỉ '\r\n' thì '\r' kéo con trỏ về cột 0 và đè chữ).
          term.write('\r\n\x1b[2K');
          term.writeln(`\x1b[33m${tRef.current('terminal.sessionExited', { code: msg.code ?? 0 })}\x1b[0m`);
          term.writeln(`\x1b[33m${tRef.current('terminal.reconnectHint')}\x1b[0m`);
          setAlive(false);
        } else if (msg.type === 'closed') {
          term.write('\r\n\x1b[2K');
          term.writeln(`\x1b[31m${tRef.current('terminal.disconnected')}\x1b[0m`);
          term.writeln(`\x1b[31m${tRef.current('terminal.reconnectHint')}\x1b[0m`);
          setAlive(false);
        }
      })
      .catch((e) => {
        if (!disposed) {
          term.write('\r\n\x1b[2K');
          term.writeln(`\x1b[31m${tRef.current('terminal.errOpen', { message: String(e) })}\x1b[0m`);
        }
        setAlive(false);
      });

    // Fit lại sau khi layout ổn định (đề phòng lần fit đồng bộ đầu chưa đo đúng kích thước)
    setTimeout(doFit, 60);
    const ro = new ResizeObserver(() => doFit());
    ro.observe(containerRef.current);
    const onWinResize = () => doFit();
    window.addEventListener('resize', onWinResize);

    return () => {
      disposed = true;
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      dataSub.dispose();
      resizeSub.dispose();
      void api.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  const startDrag = (e: React.MouseEvent) => {
    if (!floating || maximized) return; // chỉ kéo được ở chế độ nổi và chưa full màn hình
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({ x: Math.max(0, d.ox + ev.clientX - d.sx), y: Math.max(0, d.oy + ev.clientY - d.sy) });
    };
    const up = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const handleDetectLog = async () => {
    if (logPaths && !detecting) { setLogMenu(m => !m); return; }
    setDetecting(true);
    setLogMenu(true);
    setDetectError(null);
    const det = await dbHelper.detectLogPaths(connId, config.type);
    setLogPaths(det.paths);
    setDetectError(det.error || null);
    setDetecting(false);
  };

  // Windows: Get-Content -Wait không bắt kịp phần mysqld ghi thêm; ReadLine() lại cắt dòng dở dang
  // và log MySQL xuống dòng bằng \n (thiếu \r) -> xterm bị "cầu thang". Nên: mở kèm FileShare.ReadWrite,
  // nhảy tới cuối file, đọc RAW ReadToEnd() mỗi 250ms rồi chuẩn hoá về \r\n trước khi in.
  // Escape cho chuỗi nháy đơn PowerShell: ' -> ''  (tránh vỡ lệnh khi path chứa dấu nháy đơn)
  const psq = (p: string) => p.replace(/'/g, "''");

  const winTail = (p: string) =>
    `$p='${psq(p)}'; $fs=[System.IO.File]::Open($p,'Open','Read','ReadWrite'); $sr=New-Object System.IO.StreamReader($fs,[System.Text.Encoding]::UTF8); [void]$fs.Seek(0,'End'); $cr=[char]13; $lf=[char]10; Write-Host '--- theo doi log (Ctrl+C de dung) ---'; while($true){ $c=$sr.ReadToEnd(); if($c.Length -gt 0){ [Console]::Out.Write($c.Replace($cr.ToString(),'').Replace($lf.ToString(),$cr.ToString()+$lf.ToString())); [Console]::Out.Flush() } else { Start-Sleep -Milliseconds 250 } }`;

  // Lệnh tail/list tuỳ NGUỒN LOG:
  //  - docker: docker exec <container> tail -f/ls (log nằm trong container Linux)
  //  - ssh:    ssh <target> "tail -f/ls" (log on VM Linux)
  //  - local:  chạy thẳng trên shell hiện tại (remote Linux nếu terminal là SSH, hoặc Windows host)
  const src = (): 'local' | 'ssh' | 'docker' =>
    (logSource === 'ssh' && sshTarget.trim()) ? 'ssh'
      : (logSource === 'docker' && dockerContainer.trim()) ? 'docker'
        : 'local';

  const tailCommand = (p: string) => {
    switch (src()) {
      case 'ssh': return `ssh ${sshTarget.trim()} "tail -f '${p}'"`;
      case 'docker': return `docker exec ${dockerContainer.trim()} tail -f '${p}'`;
      default: return useSsh ? `tail -f "${p}"` : winTail(p);
    }
  };

  // datadir là THƯ MỤC -> không tail được, thay vào đó liệt kê file trong đó.
  const isFolder = (lp: { label: string; path: string }) => lp.label === 'datadir' || /[\\/]$/.test(lp.path);
  const listCommand = (p: string) => {
    switch (src()) {
      case 'ssh': return `ssh ${sshTarget.trim()} "ls -lah '${p}'"`;
      case 'docker': return `docker exec ${dockerContainer.trim()} ls -lah '${p}'`;
      default: return useSsh
        ? `ls -lah "${p}"`
        : `Get-ChildItem -Path '${psq(p)}' -Filter *.log | Format-Table Name,Length,LastWriteTime -AutoSize`;
    }
  };

  // ——— run SQL ngay in panel ———
  // SQL KHÔNG đi qua shell mà chạy trên kết nối DB hiện tại rồi in kết quả ra
  // terminal, nên vẫn dùng được cả khi phiên shell đã chết.
  const MAX_SQL_ROWS = 50;
  const MAX_CELL = 28;

  const ansi = {
    dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
    head: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
    ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
    err: (s: string) => `\x1b[31m${s}\x1b[0m`,
  };

  const cellText = (v: any) => {
    if (v === null || v === undefined) return 'NULL';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > MAX_CELL ? s.slice(0, MAX_CELL - 1) + '…' : s;
  };

  // In bảng kết quả dạng ASCII, canh cột theo độ rộng nội dung thật.
  const printTable = (columns: string[], rows: any[]) => {
    const term = termRef.current;
    if (!term) return;
    const shown = rows.slice(0, MAX_SQL_ROWS);
    const widths = columns.map((c, i) =>
      Math.max(c.length, ...shown.map(r => cellText(Object.values(r)[i]).length), 3)
    );
    const line = (l: string, m: string, r: string) =>
      ansi.dim(l + widths.map(w => '─'.repeat(w + 2)).join(m) + r);
    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

    term.writeln(line('┌', '┬', '┐'));
    term.writeln(ansi.dim('│') + columns.map((c, i) => ' ' + ansi.head(pad(c, widths[i])) + ' ').join(ansi.dim('│')) + ansi.dim('│'));
    term.writeln(line('├', '┼', '┤'));
    for (const row of shown) {
      const vals = Object.values(row);
      term.writeln(
        ansi.dim('│') +
        // Not named `t` — that is the translation function.
        columns.map((_, i) => {
          const cell = cellText(vals[i]);
          return ' ' + (cell === 'NULL' ? ansi.dim(pad(cell, widths[i])) : pad(cell, widths[i])) + ' ';
        }).join(ansi.dim('│')) +
        ansi.dim('│')
      );
    }
    term.writeln(line('└', '┴', '┘'));
    term.writeln(ansi.dim(
      rows.length > MAX_SQL_ROWS
        ? t('terminal.rowCountClipped', { n: rows.length, shown: MAX_SQL_ROWS })
        : t('terminal.rowCount', { n: rows.length })
    ));
  };

  const runSql = async () => {
    const sql = sqlText.trim();
    if (!sql || sqlBusy) return;
    const term = termRef.current;
    setSqlBusy(true);
    setSqlHistory(h => (h[h.length - 1] === sql ? h : [...h, sql]).slice(-50));
    setHistIdx(null);
    freshLine();
    term?.writeln(`\x1b[1;35msql>\x1b[0m ${sql}`);
    try {
      const res = await dbHelper.executeQueryMulti(connId, sql);
      if (!res.success) {
        term?.writeln(ansi.err(t('terminal.sqlError', { message: res.error || t('terminal.unknownReason') })));
      } else {
        for (const r of res.results) {
          if (r.columns && r.columns.length > 0) {
            printTable(r.columns, r.data || []);
          } else {
            // Lệnh không trả bảng (INSERT/UPDATE/DDL...)
            term?.writeln(ansi.ok(t('terminal.sqlOk')));
          }
        }
        if (res.results.length === 0) term?.writeln(ansi.ok(t('terminal.sqlOk')));
      }
    } catch (e: any) {
      term?.writeln(ansi.err(t('terminal.sqlError', { message: e?.message || e })));
    } finally {
      setSqlBusy(false);
      setSqlText('');
    }
  };

  // Mọi thao tác log đều hoạt động bằng cách GÕ LỆNH vào shell. Nếu phiên đã chết
  // thì api.input() rơi vào hư không mà không báo gì — phải chặn và nói rõ.
  const sendCommand = (cmd: string) => {
    if (!alive) {
      note(t('terminal.errSessionClosed'), 'err');
      return false;
    }
    apiRef.current?.input(cmd + '\r');
    return true;
  };

  // Docker: image MySQL/PG chính thức ghi log ra stdout -> docker logs -f là cách xem đúng.
  const dockerLogs = () => {
    if (!dockerContainer.trim()) return;
    if (sendCommand(`docker logs -f ${dockerContainer.trim()}`)) setLogMenu(false);
  };

  const runItem = (lp: { label: string; path: string }) => {
    if (sendCommand(isFolder(lp) ? listCommand(lp.path) : tailCommand(lp.path))) setLogMenu(false);
  };

  const copyPath = (p: string) => { try { navigator.clipboard?.writeText(p); } catch { /* ignore */ } };

  const freshLine = () => termRef.current?.write('\r\n\x1b[2K');

  // Thông báo của app hiện ở THANH RIÊNG, không ghi vào buffer terminal nữa.
  // Lý do: PowerShell/PSReadLine tự vẽ lại dòng bằng cursor movement (\r, \x1b[A)
  // và nó sở hữu con trỏ — bất cứ chữ nào app chèn vào buffer đều có thể bị shell
  // vẽ chồng lên. '\x1b[2K' không giải quyết được vì đây là cuộc đua về con trỏ,
  // không phải chuyện thiếu ký tự xuống dòng.
  const note = (s: string, kind: 'info' | 'ok' | 'err' = 'info') => {
    setBanner({ text: s, kind });
    if (bannerTimer.current) window.clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => setBanner(null), kind === 'err' ? 9000 : 5000);
  };

  // Enabling logging writes to the server config, so it must still be confirmed;
  // window.confirm shows nothing in the Tauri webview (the dialog plugin has no `confirm`
  // command), so clicking the menu entry used to run straight through without asking.
  const handleEnableLog = (kind: string, confirmMsg: string) => {
    setSetupMenu(false);
    setEnableLogPrompt({ kind, message: confirmMsg });
  };

  const doEnableLog = async (kind: string) => {
    note(t('terminal.enablingLog'));
    const res = await dbHelper.enableLogging(connId, config.type, kind);
    if (!res.success) {
      note(t('terminal.errEnableLog', { message: res.message || t('terminal.errEnableLogPerm') }), 'err');
      return;
    }
    if (res.needsRestart) {
      note(t('terminal.needsRestart'), 'err');
      return;
    }
    note(t('terminal.logEnabledDetecting'));
    const det = await dbHelper.detectLogPaths(connId, config.type);
    setLogPaths(det.paths);
    setDetectError(det.error || null);
    setLogMenu(true);
    // In kết quả ra ngay terminal: trước đây chỉ mở menu, nếu menu rỗng thì
    // người dùng thấy tiến trình đứng lại ở "Đang dò đường dẫn..." mà không hiểu vì sao.
    if (det.error) {
      note(t('terminal.errDetectPaths', { message: det.error }), 'err');
    } else if (det.paths.length === 0) {
      note(t('terminal.noLogPaths'));
    } else {
      note(t('terminal.foundLogPaths', { n: det.paths.length }), 'ok');
    }
  };

  const handleDisableLog = async (kind: string) => {
    setSetupMenu(false);
    const res = await dbHelper.disableLogging(connId, config.type, kind);
    note(
      res.success ? t('terminal.logDisabled') : t('terminal.errDisableLog', { message: res.message }),
      res.success ? 'ok' : 'err'
    );
  };

  // Các mục bật/tắt log theo dialect
  const setupItems: { label: string; danger?: boolean; onClick: () => void }[] = (() => {
    if (config.type === 'mysql') {
      return [
        { label: t('terminal.mysqlEnableSlow'), onClick: () => handleEnableLog('slow', t('terminal.mysqlEnableSlowConfirm')) },
        { label: t('terminal.mysqlEnableGeneral'), onClick: () => handleEnableLog('general', t('terminal.mysqlEnableGeneralConfirm')) },
        { label: t('terminal.mysqlDisableSlow'), danger: true, onClick: () => handleDisableLog('slow') },
        { label: t('terminal.mysqlDisableGeneral'), danger: true, onClick: () => handleDisableLog('general') },
      ];
    }
    if (config.type === 'postgres') {
      return [
        { label: t('terminal.pgEnableStatements'), onClick: () => handleEnableLog('statements', t('terminal.pgEnableStatementsConfirm')) },
        { label: t('terminal.pgEnableCollector'), onClick: () => handleEnableLog('collector', t('terminal.pgEnableCollectorConfirm')) },
        { label: t('terminal.pgDisableStatements'), danger: true, onClick: () => handleDisableLog('statements') },
      ];
    }
    return [];
  })();

  const title = useSsh ? 'SSH Terminal' : 'Local Terminal';
  const subtitle = useSsh
    ? `${config.sshUser || 'root'}@${config.sshHost}:${config.sshPort || 22}`
    : t('terminal.localShell');

  // Style gốc theo chế độ
  const rootStyle: React.CSSProperties = floating
    ? (maximized
        // Full = lấp đầy vùng nội dung của app (không phủ title bar / thanh tab / sidebar)
        ? { position: 'absolute', inset: 0, zIndex: 40 }
        : {
            position: 'fixed', top: pos.y, left: pos.x,
            width: '820px', height: '460px', minWidth: '420px', minHeight: '240px',
            resize: 'both', overflow: 'hidden', zIndex: 5000,
          })
    : {
        position: 'absolute', inset: 0,
        display: active ? 'flex' : 'none',
      };

  return (
    <div
      style={{
        ...rootStyle,
        background: '#1c1c1e',
        border: floating && !maximized ? '1px solid var(--win-border, #383b44)' : 'none',
        borderRadius: floating && !maximized ? '8px' : 0,
        boxShadow: floating && !maximized ? '0 12px 48px rgba(0,0,0,0.5)' : 'none',
        flexDirection: 'column',
        // floating luôn hiện (flex); docked chỉ hiện khi tab active
        display: floating ? 'flex' : (active ? 'flex' : 'none'),
      }}
    >
      <div
        onMouseDown={startDrag}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 10px', background: '#26272b',
          borderBottom: '1px solid #383b44', flexShrink: 0,
          cursor: floating ? 'move' : 'default', userSelect: 'none',
        }}
      >
        {/* Tiêu đề: thêm đèn trạng thái phiên (xanh = đang chạy, đỏ = đã đóng) và
            gom tên/địa chỉ thành 2 dòng cho đỡ chật khi cửa sổ hẹp. */}
        <div className="tp-title">
          <TerminalSquare size={15} style={{ flexShrink: 0, opacity: 0.8 }} />
          <span className={`tp-dot ${alive ? 'on' : 'off'}`} title={alive ? t('terminal.sessionAlive') : t('terminal.sessionDead')} />
          <div style={{ minWidth: 0 }}>
            <div className="tp-title-main">{title}{profileName ? ` — ${profileName}` : ''}</div>
            <div className="tp-title-sub">{subtitle}</div>
          </div>
        </div>
        <div className="tp-actions" onMouseDown={(e) => e.stopPropagation()}>
          {/* Phiên chết thì panel trở thành cục gạch: shell chỉ được mở một lần trong
              effect khởi tạo, không có đường nào mở lại ngoài đóng hẳn terminal. */}
          {!alive && (
            <button className="tp-btn warn" onClick={() => setEpoch(e => e + 1)} title={t('terminal.reconnectTitle')}>
              <RefreshCw size={13} />
              <span>{t('terminal.reconnect')}</span>
            </button>
          )}

          {/* Chạy SQL: không đi qua shell nên dùng được cả khi phiên đã đóng */}
          {config.type !== 'redis' && (
            <button
              className={`tp-btn ${sqlBar ? 'on' : ''}`}
              onClick={() => { setSqlBar(v => !v); setLogMenu(false); setSetupMenu(false); }}
              title={t('terminal.runSqlTitle')}
            >
              <Play size={12} />
              <span>SQL</span>
            </button>
          )}

          {/* Bật log (chỉ MySQL/Postgres) */}
          {config.type !== 'sqlite' && (
            <div style={{ position: 'relative' }}>
              <button
                className="tp-btn"
                onClick={() => { setSetupMenu(m => !m); setLogMenu(false); }}
                style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', gap: '4px' }}
                title={t('terminal.setupLogTitle')}
              >
                <ScrollText size={13} />
                <span>{t('terminal.setupLog')}</span>
              </button>
              {setupMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setSetupMenu(false)} />
                  <div className="tp-menu" style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, minWidth: '280px', zIndex: 999, padding: '5px', fontSize: '11px' }}>
                    {setupItems.map((it, i) => (
                      <button
                        key={i}
                        className="context-menu-item"
                        onClick={it.onClick}
                        style={{ display: 'flex', alignItems: 'center', width: '100%', padding: '6px 8px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: it.danger ? '#ef4444' : 'var(--win-text-primary)' }}
                      >
                        {it.label}
                      </button>
                    ))}
                    <div style={{ padding: '6px 8px', color: 'var(--win-text-disabled)', lineHeight: 1.35, borderTop: '1px solid var(--win-border)' }}>
                      {t('terminal.setupLogNote')}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {/* scan log */}
          <div style={{ position: 'relative' }}>
            <button
              className="tp-btn"
              onClick={handleDetectLog}
              style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', gap: '4px' }}
              title={t('terminal.findLogsTitle')}
            >
              <FileSearch size={13} />
              <span>{t('terminal.findLogs')}</span>
            </button>
            {logMenu && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setLogMenu(false)} />
                <div className="tp-menu" style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, width: '360px', maxWidth: '80vw', zIndex: 999, overflow: 'hidden', fontSize: '11px' }}>
                  {/* Nguồn log: Local / SSH (VM) / Docker */}
                  <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--win-border)' }}>
                    <div style={{ color: 'var(--win-text-secondary)', fontWeight: 600, marginBottom: '6px' }}>{t('terminal.logSource')}</div>
                    <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
                      {(['local', 'ssh', 'docker'] as const).map(m => (
                        <button
                          key={m}
                          onClick={() => setLogSource(m)}
                          className={`tp-btn ${logSource === m ? 'on' : ''}`}
                          style={{ flex: 1, justifyContent: 'center' }}
                        >
                          {m === 'local' ? 'Local' : m === 'ssh' ? 'SSH (VM)' : 'Docker'}
                        </button>
                      ))}
                    </div>
                    {logSource === 'ssh' && (
                      <input
                        value={sshTarget}
                        onChange={(e) => setSshTarget(e.target.value)}
                        placeholder="vd: dev@localhost -p 2222"
                        style={{ width: '100%', padding: '4px 6px', fontSize: '11px', background: 'var(--win-bg-input, #1c1c1e)', color: 'var(--win-text-primary)', border: '1px solid var(--win-border)', borderRadius: '4px', outline: 'none', boxSizing: 'border-box' }}
                      />
                    )}
                    {logSource === 'docker' && (
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <input
                          value={dockerContainer}
                          onChange={(e) => setDockerContainer(e.target.value)}
                          placeholder={t('terminal.dockerContainerPlaceholder')}
                          style={{ flex: 1, padding: '4px 6px', fontSize: '11px', background: 'var(--win-bg-input, #1c1c1e)', color: 'var(--win-text-primary)', border: '1px solid var(--win-border)', borderRadius: '4px', outline: 'none', boxSizing: 'border-box' }}
                        />
                        <button className="tp-btn" onClick={dockerLogs} disabled={!dockerContainer.trim()} style={{ padding: '2px 8px', whiteSpace: 'nowrap' }} title="docker logs -f (log ra stdout)">
                          logs -f
                        </button>
                      </div>
                    )}
                  </div>
                  <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', fontWeight: 600 }}>
                    {t('terminal.logPathsHint')}
                  </div>
                  <div style={{ maxHeight: '300px', overflowY: 'auto', padding: '4px' }}>
                    {detecting ? (
                      <div style={{ padding: '10px', color: 'var(--win-text-secondary)' }}>{t('terminal.detecting')}</div>
                    ) : logPaths && logPaths.length > 0 ? (
                      logPaths.map((lp, i) => {
                        const folder = isFolder(lp);
                        return (
                          <div
                            key={i}
                            className="context-menu-item"
                            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer' }}
                            onClick={() => runItem(lp)}
                            title={folder ? t('terminal.listInFolder', { path: lp.path }) : t('terminal.tailPath', { path: lp.path })}
                          >
                            {folder ? <FolderOpen size={14} style={{ flexShrink: 0, color: 'var(--win-text-secondary)' }} /> : <FileSearch size={14} style={{ flexShrink: 0, color: 'var(--win-accent)' }} />}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ color: 'var(--win-accent)', fontSize: '10px' }}>
                                {lp.label}{folder ? t('terminal.folderSuffix') : ''}
                              </div>
                              <div style={{ color: 'var(--win-text-primary)', wordBreak: 'break-all', lineHeight: 1.3 }}>{lp.path}</div>
                            </div>
                            <button
                              className="tp-btn"
                              onClick={(e) => { e.stopPropagation(); copyPath(lp.path); }}
                              style={{ flexShrink: 0 }}
                              title={t('terminal.copyPath')}
                            >
                              <Copy size={12} />
                            </button>
                          </div>
                        );
                      })
                    ) : detectError ? (
                      /* Hiện đúng lỗi từ DB (mất kết nối, thiếu quyền...) thay vì
                         gộp chung vào thông báo "không tìm thấy file log". */
                      <div style={{ padding: '10px', color: 'var(--st-danger)', lineHeight: 1.5 }}>
                        {t('terminal.errDetectHeading')}
                        <div style={{ marginTop: '4px', color: 'var(--win-text-secondary)', fontFamily: 'var(--win-font-mono)', fontSize: '10px', whiteSpace: 'pre-wrap' }}>
                          {detectError}
                        </div>
                      </div>
                    ) : (
                      <div style={{ padding: '10px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                        {t('terminal.noLogFile')}{' '}
                        <Trans i18nKey="terminal.noLogFileHint" components={{ code: <code /> }} />
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {!inOwnWindow && (
            <button
              className="tp-btn"
              onClick={() => openTerminalWindow(config, profileName)}
              style={{ padding: '2px 6px', display: 'flex', alignItems: 'center' }}
              title={t('terminal.openInOwnWindow')}
            >
              <ExternalLink size={14} />
            </button>
          )}
          {floating && (
            <button
              className="tp-btn"
              onClick={() => setMaximized(m => !m)}
              style={{ padding: '2px 6px', display: 'flex', alignItems: 'center' }}
              title={maximized ? t('terminal.restoreWindow') : t('terminal.fullScreen')}
            >
              {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          {onToggleFloat && (
            <button
              className="tp-btn"
              onClick={onToggleFloat}
              style={{ padding: '2px 6px', display: 'flex', alignItems: 'center' }}
              title={floating ? t('terminal.dockToTab') : t('terminal.popOut')}
            >
              {floating ? <PanelBottom size={14} /> : <PictureInPicture2 size={14} />}
            </button>
          )}

        </div>
      </div>
      {/* Thanh thông báo của app — nằm NGOÀI buffer terminal nên shell không thể
          vẽ chồng lên (PSReadLine sở hữu con trỏ và tự redraw dòng). */}
      {banner && (
        <div className={`tp-banner ${banner.kind}`}>
          <span>{banner.text}</span>
          <button className="tp-banner-close" onClick={() => setBanner(null)} title={t('common.close')} aria-label={t('common.close')}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* Ô chạy SQL: nằm giữa header và terminal, kết quả in xuống terminal ngay dưới */}
      {sqlBar && (
        <div className="tp-sqlbar">
          <span className="tp-sql-prompt">sql&gt;</span>
          <input
            className="tp-sql-input"
            value={sqlText}
            onChange={(e) => { setSqlText(e.target.value); setHistIdx(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { void runSql(); return; }
              if (e.key === 'Escape') { setSqlBar(false); return; }
              // Mũi tên lên/xuống duyệt lại các câu đã chạy, như một REPL thật
              if (e.key === 'ArrowUp' && sqlHistory.length) {
                e.preventDefault();
                const i = histIdx === null ? sqlHistory.length - 1 : Math.max(0, histIdx - 1);
                setHistIdx(i); setSqlText(sqlHistory[i]);
              }
              if (e.key === 'ArrowDown' && histIdx !== null) {
                e.preventDefault();
                const i = histIdx + 1;
                if (i >= sqlHistory.length) { setHistIdx(null); setSqlText(''); }
                else { setHistIdx(i); setSqlText(sqlHistory[i]); }
              }
            }}
            placeholder={sqlHistory.length ? t('terminal.sqlPlaceholderHistory') : t('terminal.sqlPlaceholder')}
            spellCheck={false}
            autoFocus
          />
          <button className="tp-btn" onClick={() => void runSql()} disabled={sqlBusy || !sqlText.trim()} title={t('terminal.runTitle')}>
            {sqlBusy ? <RefreshCw size={12} className="loading-spinner" /> : <Play size={12} />}
            <span>{t('terminal.run')}</span>
          </button>
          <button className="tp-btn" onClick={() => { termRef.current?.clear(); }} title={t('terminal.clearScreen')}>
            <Eraser size={12} />
          </button>
        </div>
      )}

      <div ref={containerRef} style={{ flex: 1, padding: '6px', overflow: 'hidden' }} />

      {/* Enable-logging confirmation — the question comes from the menu entry itself
          (one wording per log kind). */}
      {enableLogPrompt && (
        <ConfirmDialog
          open
          title={t('terminal.enableLogTitle')}
          message={enableLogPrompt.message}
          onConfirm={() => { const kind = enableLogPrompt.kind; setEnableLogPrompt(null); doEnableLog(kind); }}
          onCancel={() => setEnableLogPrompt(null)}
        />
      )}
    </div>
  );
};
