import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { X, TerminalSquare, PictureInPicture2, PanelBottom, FileSearch, ScrollText, Maximize2, Minimize2, ExternalLink, Copy, FolderOpen } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import type { DbConnectionConfig, SshTerminalMessage } from '../utils/dbHelper';
import { openTerminalWindow } from '../utils/terminalWindow';

interface TerminalPanelProps {
  config: DbConnectionConfig;
  profileName?: string;
  onClose: () => void;
  floating?: boolean;          // true = cửa sổ nổi; false = ghim trong tab
  active?: boolean;            // (chế độ ghim) tab này có đang active không -> quyết định hiện/ẩn
  onToggleFloat?: () => void;  // có -> hiện nút pop-out/dock
  inOwnWindow?: boolean;       // đang chạy trong cửa sổ OS riêng -> ẩn nút "Cửa sổ mới" + lấp đầy
}

// Terminal thông minh: profile có SSH -> shell từ xa; ngược lại -> shell máy cục bộ.
// Hai chế độ hiển thị:
//   - Ghim (docked): lấp đầy vùng nội dung của tab, chỉ hiện khi tab active (ẩn = display:none,
//     KHÔNG unmount -> phiên PTY sống khi chuyển tab).
//   - Nổi (floating): cửa sổ nổi kéo di chuyển được, hiện bất kể tab nào đang active.
export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  config,
  profileName,
  onClose,
  floating = false,
  active = true,
  onToggleFloat,
  inOwnWindow = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string>(`term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const apiRef = useRef<{ input: (d: string) => void } | null>(null);
  const termRef = useRef<Terminal | null>(null);

  const [pos, setPos] = useState({ x: 240, y: 90 });
  const [maximized, setMaximized] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const [logMenu, setLogMenu] = useState(false);
  const [logPaths, setLogPaths] = useState<{ label: string; path: string }[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [setupMenu, setSetupMenu] = useState(false);

  // Nguồn log: chạy lệnh tail thẳng (local), bọc qua ssh (VM), hay docker exec/logs (Docker).
  const [logSource, setLogSource] = useState<'local' | 'ssh' | 'docker'>(() => (localStorage.getItem('term_log_source') as any) || 'local');
  const [sshTarget, setSshTarget] = useState(() => localStorage.getItem('term_ssh_target') || '');
  const [dockerContainer, setDockerContainer] = useState(() => localStorage.getItem('term_docker_container') || '');
  useEffect(() => { localStorage.setItem('term_log_source', logSource); }, [logSource]);
  useEffect(() => { localStorage.setItem('term_ssh_target', sshTarget); }, [sshTarget]);
  useEffect(() => { localStorage.setItem('term_docker_container', dockerContainer); }, [dockerContainer]);

  const useSsh = !!(config.sshEnabled && config.sshHost);

  useEffect(() => {
    if (!containerRef.current) return;
    const sessionId = sessionIdRef.current;

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
          term.writeln(`\r\n\x1b[33m[Phiên shell kết thúc, mã thoát ${msg.code ?? 0}]\x1b[0m`);
        } else if (msg.type === 'closed') {
          term.writeln('\r\n\x1b[31m[Đã ngắt kết nối]\x1b[0m');
        }
      })
      .catch((e) => {
        if (!disposed) term.writeln(`\r\n\x1b[31m[Lỗi mở Terminal] ${e}\x1b[0m`);
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
  }, []);

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
    const paths = await dbHelper.detectLogPaths(config.type);
    setLogPaths(paths);
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
  //  - ssh:    ssh <target> "tail -f/ls" (log trên VM Linux)
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

  // Docker: image MySQL/PG chính thức ghi log ra stdout -> docker logs -f là cách xem đúng.
  const dockerLogs = () => {
    if (!dockerContainer.trim()) return;
    apiRef.current?.input(`docker logs -f ${dockerContainer.trim()}\r`);
    setLogMenu(false);
  };

  const runItem = (lp: { label: string; path: string }) => {
    apiRef.current?.input((isFolder(lp) ? listCommand(lp.path) : tailCommand(lp.path)) + '\r');
    setLogMenu(false);
  };

  const copyPath = (p: string) => { try { navigator.clipboard?.writeText(p); } catch { /* ignore */ } };

  const note = (s: string) => termRef.current?.writeln(`\r\n\x1b[36m[TableNova] ${s}\x1b[0m`);

  const handleEnableLog = async (kind: string, confirmMsg: string) => {
    setSetupMenu(false);
    if (!window.confirm(confirmMsg)) return;
    note('Đang bật log...');
    const res = await dbHelper.enableLogging(config.type, kind);
    if (!res.success) {
      note(`Bật log thất bại: ${res.message || 'kiểm tra quyền (SUPER/superuser).'}`);
      return;
    }
    if (res.needsRestart) {
      note('Đã ghi cấu hình, nhưng cần KHỞI ĐỘNG LẠI server DB thì logging_collector mới có tác dụng.');
      return;
    }
    note('Đã bật log. Đang dò đường dẫn...');
    const paths = await dbHelper.detectLogPaths(config.type);
    setLogPaths(paths);
    setLogMenu(true);
  };

  const handleDisableLog = async (kind: string) => {
    setSetupMenu(false);
    const res = await dbHelper.disableLogging(config.type, kind);
    note(res.success ? 'Đã tắt log.' : `Tắt log thất bại: ${res.message}`);
  };

  // Các mục bật/tắt log theo dialect
  const setupItems: { label: string; danger?: boolean; onClick: () => void }[] = (() => {
    if (config.type === 'mysql') {
      return [
        { label: 'Bật slow query log', onClick: () => handleEnableLog('slow', 'Bật slow query log (long_query_time=1s) trên MySQL server?') },
        { label: 'Bật general log (nặng — ghi mọi câu lệnh)', onClick: () => handleEnableLog('general', 'Bật GENERAL log? Ghi MỌI câu lệnh, tốn đĩa nhanh. Nhớ tắt sau khi xem.') },
        { label: 'Tắt slow query log', danger: true, onClick: () => handleDisableLog('slow') },
        { label: 'Tắt general log', danger: true, onClick: () => handleDisableLog('general') },
      ];
    }
    if (config.type === 'postgres') {
      return [
        { label: 'Bật log_statement=all (reload, ra stderr)', onClick: () => handleEnableLog('statements', "ALTER SYSTEM SET log_statement='all' rồi reload cấu hình Postgres?") },
        { label: 'Bật logging_collector (cần restart)', onClick: () => handleEnableLog('collector', "ALTER SYSTEM SET logging_collector='on'? Chỉ có tác dụng sau khi RESTART server thủ công.") },
        { label: 'Tắt log_statement', danger: true, onClick: () => handleDisableLog('statements') },
      ];
    }
    return [];
  })();

  const title = useSsh ? 'SSH Terminal' : 'Local Terminal';
  const subtitle = useSsh
    ? `${config.sshUser || 'root'}@${config.sshHost}:${config.sshPort || 22}`
    : 'shell máy cục bộ';

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
          padding: '6px 10px', background: 'var(--win-bg-card, #26272b)',
          borderBottom: '1px solid var(--win-border, #383b44)', flexShrink: 0,
          cursor: floating ? 'move' : 'default', userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--win-text-primary, #e5e5e7)', minWidth: 0 }}>
          <TerminalSquare size={14} style={{ flexShrink: 0 }} />
          <span style={{ whiteSpace: 'nowrap' }}>{title}{profileName ? ` — ${profileName}` : ''}</span>
          <span style={{ color: 'var(--win-text-disabled, #8a8a8f)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }} onMouseDown={(e) => e.stopPropagation()}>
          {/* Bật log (chỉ MySQL/Postgres) */}
          {config.type !== 'sqlite' && (
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                onClick={() => { setSetupMenu(m => !m); setLogMenu(false); }}
                style={{ padding: '2px 6px', height: '22px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}
                title="Bật/tắt ghi log ở phía DB server"
              >
                <ScrollText size={13} />
                <span>Bật log</span>
              </button>
              {setupMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setSetupMenu(false)} />
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, minWidth: '280px', background: 'var(--win-bg-card, #26272b)', border: '1px solid var(--win-border, #383b44)', borderRadius: '6px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 999, padding: '4px', fontSize: '11px' }}>
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
                      Cần quyền cao (SUPER/superuser). Đây là thao tác đổi cấu hình server.
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {/* Dò log */}
          <div style={{ position: 'relative' }}>
            <button
              className="btn btn-secondary"
              onClick={handleDetectLog}
              style={{ padding: '2px 6px', height: '22px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}
              title="Dò đường dẫn file log của DB rồi tail"
            >
              <FileSearch size={13} />
              <span>Dò log</span>
            </button>
            {logMenu && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setLogMenu(false)} />
                <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, width: '360px', maxWidth: '80vw', background: 'var(--win-bg-card, #26272b)', border: '1px solid var(--win-border, #383b44)', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 999, overflow: 'hidden', fontSize: '11px' }}>
                  {/* Nguồn log: Local / SSH (VM) / Docker */}
                  <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--win-border)' }}>
                    <div style={{ color: 'var(--win-text-secondary)', fontWeight: 600, marginBottom: '6px' }}>Nguồn log</div>
                    <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
                      {(['local', 'ssh', 'docker'] as const).map(m => (
                        <button
                          key={m}
                          onClick={() => setLogSource(m)}
                          className="btn btn-secondary"
                          style={{ flex: 1, padding: '3px 4px', height: '24px', fontSize: '11px', ...(logSource === m ? { background: 'var(--win-accent)', color: '#fff', borderColor: 'var(--win-accent)' } : {}) }}
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
                          placeholder="tên container (vd: mysql8)"
                          style={{ flex: 1, padding: '4px 6px', fontSize: '11px', background: 'var(--win-bg-input, #1c1c1e)', color: 'var(--win-text-primary)', border: '1px solid var(--win-border)', borderRadius: '4px', outline: 'none', boxSizing: 'border-box' }}
                        />
                        <button className="btn btn-secondary" onClick={dockerLogs} disabled={!dockerContainer.trim()} style={{ padding: '2px 8px', fontSize: '11px', whiteSpace: 'nowrap' }} title="docker logs -f (log ra stdout)">
                          logs -f
                        </button>
                      </div>
                    )}
                  </div>
                  <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', fontWeight: 600 }}>
                    Đường dẫn log — bấm để theo dõi
                  </div>
                  <div style={{ maxHeight: '300px', overflowY: 'auto', padding: '4px' }}>
                    {detecting ? (
                      <div style={{ padding: '10px', color: 'var(--win-text-secondary)' }}>Đang dò...</div>
                    ) : logPaths && logPaths.length > 0 ? (
                      logPaths.map((lp, i) => {
                        const folder = isFolder(lp);
                        return (
                          <div
                            key={i}
                            className="context-menu-item"
                            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer' }}
                            onClick={() => runItem(lp)}
                            title={folder ? `Liệt kê file log trong: ${lp.path}` : `Theo dõi: ${lp.path}`}
                          >
                            {folder ? <FolderOpen size={14} style={{ flexShrink: 0, color: 'var(--win-text-secondary)' }} /> : <FileSearch size={14} style={{ flexShrink: 0, color: 'var(--win-accent)' }} />}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ color: 'var(--win-accent)', fontSize: '10px' }}>
                                {lp.label}{folder ? ' (thư mục)' : ''}
                              </div>
                              <div style={{ color: 'var(--win-text-primary)', wordBreak: 'break-all', lineHeight: 1.3 }}>{lp.path}</div>
                            </div>
                            <button
                              className="btn btn-secondary"
                              onClick={(e) => { e.stopPropagation(); copyPath(lp.path); }}
                              style={{ padding: '2px 5px', height: '20px', display: 'flex', alignItems: 'center', flexShrink: 0 }}
                              title="Sao chép đường dẫn"
                            >
                              <Copy size={12} />
                            </button>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ padding: '10px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                        Không tìm thấy file log. DB có thể ghi ra stderr/syslog/TABLE, hoặc chưa kết nối.
                        Thử <code>journalctl -u postgresql</code> / <code>-u mysql</code> hoặc Event Viewer.
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {!inOwnWindow && (
            <button
              className="btn btn-secondary"
              onClick={() => openTerminalWindow(config, profileName)}
              style={{ padding: '2px 6px', height: '22px', display: 'flex', alignItems: 'center' }}
              title="Mở trong cửa sổ riêng"
            >
              <ExternalLink size={14} />
            </button>
          )}
          {floating && (
            <button
              className="btn btn-secondary"
              onClick={() => setMaximized(m => !m)}
              style={{ padding: '2px 6px', height: '22px', display: 'flex', alignItems: 'center' }}
              title={maximized ? 'Thu nhỏ cửa sổ' : 'Toàn màn hình'}
            >
              {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          {onToggleFloat && (
            <button
              className="btn btn-secondary"
              onClick={onToggleFloat}
              style={{ padding: '2px 6px', height: '22px', display: 'flex', alignItems: 'center' }}
              title={floating ? 'Ghim vào tab' : 'Tách ra cửa sổ nổi'}
            >
              {floating ? <PanelBottom size={14} /> : <PictureInPicture2 size={14} />}
            </button>
          )}
          <button
            className="btn btn-secondary"
            onClick={onClose}
            style={{ padding: '2px 6px', height: '22px', display: 'flex', alignItems: 'center' }}
            title="Đóng terminal"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div ref={containerRef} style={{ flex: 1, padding: '6px', overflow: 'hidden' }} />
    </div>
  );
};
