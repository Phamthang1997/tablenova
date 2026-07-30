import React, { useState, useEffect, useRef } from 'react';
import {
  Search, RefreshCw, Plus, Trash2, Key, Clock, Terminal, Activity,
  Save, Database, AlertTriangle, CheckCircle2, Layers, LogOut, Square,
} from 'lucide-react';
import { dbHelper, type RedisKeyItem, type RedisValueDetail } from '../utils/dbHelper';
import { decodeRedisValue, type DecodedRedis } from '../utils/redisDecode';

interface RedisBrowserProps {
  dbName: string;
  initialDbIndex?: number;
  onDisconnect: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  string: '#3b82f6', hash: '#10b981', list: '#f59e0b',
  set: '#8b5cf6', zset: '#ec4899', stream: '#06b6d4',
};

const SCAN_COUNT = 300;

function ttlText(ttl: number): string {
  if (ttl === -1) return '∞';
  if (ttl < 0) return '-';
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`;
  return `${Math.floor(ttl / 86400)}d`;
}

export const RedisBrowser: React.FC<RedisBrowserProps> = ({ dbName, initialDbIndex = 0, onDisconnect }) => {
  const [dbIndex, setDbIndex] = useState(initialDbIndex);
  const [pattern, setPattern] = useState('*');
  const [typeFilter, setTypeFilter] = useState('');
  const [keys, setKeys] = useState<RedisKeyItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const scanIdRef = useRef<string>('');

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<RedisValueDetail | null>(null);
  const [decoded, setDecoded] = useState<DecodedRedis | null>(null);
  const [showDecoded, setShowDecoded] = useState(true);
  const [editText, setEditText] = useState('');
  const [rightTab, setRightTab] = useState<'value' | 'console' | 'dashboard'>('value');

  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 3500);
  };

  // ---- SCAN keys (streaming) ----
  // Vừa SCAN vừa nhận batch qua Channel -> danh sách tự đầy dần. Lọc client-side theo type
  // (server có thể không hỗ trợ SCAN TYPE). Truyền pattern/type tường minh tránh stale-closure.
  const startScan = (pat: string, type: string) => {
    if (scanIdRef.current) dbHelper.cancelQuery(scanIdRef.current); // dừng scan cũ nếu đang chạy
    const id = `rscan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    scanIdRef.current = id;
    setKeys([]);
    setStreaming(true);
    dbHelper.redisScanStream(pat || '*', SCAN_COUNT, id, (msg: any) => {
      if (scanIdRef.current !== id) return; // batch của scan cũ -> bỏ
      if (msg.type === 'keys') {
        const batch: RedisKeyItem[] = msg.keys || [];
        const filtered = type ? batch.filter((k) => k.type === type) : batch;
        if (filtered.length) setKeys((prev) => [...prev, ...filtered]);
      } else if (msg.type === 'done') {
        setStreaming(false);
      } else if (msg.type === 'error') {
        setStreaming(false);
        flash('err', msg.message || 'Lỗi SCAN');
      }
    }).catch((e) => { setStreaming(false); flash('err', String(e)); });
  };

  const stopScan = () => { if (scanIdRef.current) dbHelper.cancelQuery(scanIdRef.current); setStreaming(false); };
  const refresh = () => startScan(pattern, typeFilter);
  const onChangeTypeFilter = (t: string) => { setTypeFilter(t); startScan(pattern, t); };

  // Tải lần đầu + khi đổi db index.
  useEffect(() => { startScan(pattern, typeFilter); /* eslint-disable-next-line */ }, [dbIndex]);

  // ---- Chọn key -> lấy chi tiết ----
  const selectKey = async (key: string) => {
    setSelectedKey(key);
    setRightTab('value');
    setDetail(null);
    setDecoded(null);
    const d = await dbHelper.redisGetKey(key);
    if (!d.success) { flash('err', d.message || 'Không đọc được key'); return; }
    setDetail(d);
    if (d.type === 'string') {
      const v = d.value || {};
      setEditText(v.text ?? '');
      const dec = await decodeRedisValue(v.bytes || []);
      setDecoded(dec);
      setShowDecoded(dec.format !== 'raw');
    }
  };

  const handleSelectDb = async (idx: number) => {
    const res = await dbHelper.redisSelectDb(idx);
    if (res.success) { setDbIndex(idx); setSelectedKey(null); setDetail(null); }
    else flash('err', res.error || 'Không đổi được DB');
  };

  const handleDeleteKey = async (key: string) => {
    if (!confirm(`Xóa key "${key}"?`)) return;
    const res = await dbHelper.redisDeleteKeys([key]);
    if (res.success) {
      flash('ok', `Đã xóa "${key}".`);
      setKeys((prev) => prev.filter((k) => k.key !== key));
      if (selectedKey === key) { setSelectedKey(null); setDetail(null); }
    } else flash('err', res.error || 'Xóa thất bại');
  };

  const handleNewKey = async () => {
    const name = prompt('Tên key mới (kiểu String):');
    if (!name) return;
    const res = await dbHelper.redisSetKey({ key: name, kind: 'string', value: '' });
    if (res.success) { flash('ok', `Đã tạo "${name}".`); refresh(); selectKey(name); }
    else flash('err', res.error || 'Tạo key thất bại');
  };

  const handleFlush = async () => {
    if (!confirm(`FLUSHDB — xóa TOÀN BỘ keys trong db${dbIndex}? Không thể hoàn tác.`)) return;
    const res = await dbHelper.redisFlushDb();
    if (res.success) { flash('ok', 'Đã FLUSHDB.'); refresh(); setSelectedKey(null); setDetail(null); }
    else flash('err', res.error || 'FLUSHDB thất bại');
  };

  const handleSaveString = async () => {
    if (!selectedKey) return;
    const res = await dbHelper.redisSetKey({ key: selectedKey, kind: 'string', value: editText });
    if (res.success) { flash('ok', 'Đã lưu value.'); selectKey(selectedKey); }
    else flash('err', res.error || 'Lưu thất bại');
  };

  const handleRename = async () => {
    if (!selectedKey) return;
    const nw = prompt('Đổi tên key thành:', selectedKey);
    if (!nw || nw === selectedKey) return;
    const res = await dbHelper.redisRenameKey(selectedKey, nw);
    if (res.success) { flash('ok', 'Đã đổi tên.'); refresh(); setSelectedKey(nw); selectKey(nw); }
    else flash('err', res.error || 'Đổi tên thất bại');
  };

  const handleSetTtl = async () => {
    if (!selectedKey) return;
    const s = prompt('TTL (giây). Nhập -1 để bỏ hạn (PERSIST):', String(detail?.ttl ?? -1));
    if (s === null) return;
    const ttl = parseInt(s, 10);
    if (Number.isNaN(ttl)) return;
    const res = await dbHelper.redisSetTtl(selectedKey, ttl);
    if (res.success) { flash('ok', 'Đã đặt TTL.'); selectKey(selectedKey); }
    else flash('err', res.error || 'Đặt TTL thất bại');
  };

  const badge = (type: string) => (
    <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', color: '#fff', background: TYPE_COLORS[type] || '#64748b', textTransform: 'uppercase' }}>{type}</span>
  );

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: '100%' }}>
      {/* ===== Left: Key browser ===== */}
      <div style={{ width: '340px', borderRight: '1px solid var(--win-border)', display: 'flex', flexDirection: 'column', background: 'var(--win-bg-sidebar)' }}>
        <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', borderBottom: '1px solid var(--win-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Database size={14} style={{ color: 'var(--win-accent)' }} />
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', flex: 1 }}>{dbName}</span>
            <select
              value={dbIndex}
              onChange={(e) => handleSelectDb(parseInt(e.target.value))}
              title="Chọn database index"
              style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '10px', padding: '2px 4px' }}
            >
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>db{i}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', borderRadius: '4px', padding: '0 6px' }}>
              <Search size={12} style={{ color: 'var(--win-text-disabled)' }} />
              <input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') refresh(); }}
                placeholder="MATCH pattern (vd user:*)"
                style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--win-text-primary)', fontSize: '11px', outline: 'none', padding: '5px 0' }}
              />
            </div>
            <select value={typeFilter} onChange={(e) => onChangeTypeFilter(e.target.value)} title="Lọc theo kiểu" style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '10px' }}>
              <option value="">Tất cả</option>
              <option value="string">string</option>
              <option value="hash">hash</option>
              <option value="list">list</option>
              <option value="set">set</option>
              <option value="zset">zset</option>
              <option value="stream">stream</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            {streaming ? (
              <button className="btn btn-secondary" onClick={stopScan} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', color: 'var(--st-danger)' }}><Square size={10} /> Dừng</button>
            ) : (
              <button className="btn btn-secondary" onClick={refresh} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}><RefreshCw size={11} /> Làm mới</button>
            )}
            <button className="btn btn-secondary" onClick={handleNewKey} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}><Plus size={11} /> Key mới</button>
            <button className="btn btn-secondary" onClick={handleFlush} title="FLUSHDB" style={{ width: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--st-danger)' }}><Trash2 size={11} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {keys.length === 0 && !streaming && (
            <div style={{ padding: '20px', textAlign: 'center', fontSize: '11px', color: 'var(--win-text-disabled)' }}>Không có key nào khớp.</div>
          )}
          {keys.map((k) => (
            <div
              key={k.key}
              onClick={() => selectKey(k.key)}
              className="sidebar-item"
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 10px', cursor: 'pointer', fontSize: '11px',
                background: selectedKey === k.key ? 'var(--win-bg-active)' : 'transparent',
              }}
            >
              <Key size={11} style={{ color: 'var(--win-text-disabled)', flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--win-text-primary)' }} title={k.key}>{k.key}</span>
              {k.ttl >= 0 && <span style={{ fontSize: '9px', color: 'var(--win-text-disabled)', display: 'flex', alignItems: 'center', gap: '2px' }}><Clock size={9} />{ttlText(k.ttl)}</span>}
              {badge(k.type)}
            </div>
          ))}
          {streaming && <div style={{ padding: '10px', textAlign: 'center', fontSize: '11px', color: 'var(--win-text-secondary)' }}>Đang quét... ({keys.length})</div>}
        </div>
        <div style={{ padding: '6px 10px', borderTop: '1px solid var(--win-border)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{keys.length} key{streaming ? ' · đang quét…' : ''}</div>
          <button
            className="btn btn-secondary"
            onClick={onDisconnect}
            style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}
          >
            <LogOut size={13} />
            <span>Ngắt kết nối</span>
          </button>
        </div>
      </div>

      {/* ===== Right: value / console / dashboard ===== */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-tab-bar)' }}>
          {([['value', 'Giá trị', Key], ['console', 'CLI Console', Terminal], ['dashboard', 'Dashboard', Activity]] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setRightTab(id as any)}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', fontSize: '11px', cursor: 'pointer',
                background: 'transparent', border: 'none', borderBottom: rightTab === id ? '2px solid var(--win-accent)' : '2px solid transparent',
                color: rightTab === id ? 'var(--win-text-primary)' : 'var(--win-text-secondary)', fontWeight: rightTab === id ? 600 : 400,
              }}
            >
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>

        {msg && (
          <div style={{ padding: '6px 12px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '6px', background: msg.kind === 'ok' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: msg.kind === 'ok' ? '#10b981' : 'var(--st-danger)' }}>
            {msg.kind === 'ok' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} {msg.text}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
          {rightTab === 'value' && (
            !detail ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--win-text-disabled)', fontSize: '12px' }}>
                Chọn một key ở bên trái để xem giá trị.
              </div>
            ) : (
              <ValuePanel
                detail={detail}
                decoded={decoded}
                showDecoded={showDecoded}
                setShowDecoded={setShowDecoded}
                editText={editText}
                setEditText={setEditText}
                onSave={handleSaveString}
                onRename={handleRename}
                onSetTtl={handleSetTtl}
                onDelete={() => handleDeleteKey(detail.key)}
                badge={badge}
              />
            )
          )}
          {rightTab === 'console' && <RedisConsole onError={(t) => flash('err', t)} />}
          {rightTab === 'dashboard' && <RedisDashboard onError={(t) => flash('err', t)} />}
        </div>
      </div>
    </div>
  );
};

// ---- Value panel ----
const ValuePanel: React.FC<any> = ({ detail, decoded, showDecoded, setShowDecoded, editText, setEditText, onSave, onRename, onSetTtl, onDelete, badge }) => {
  const v = detail.value || {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', height: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        {badge(detail.type)}
        <span style={{ fontFamily: 'var(--win-font-mono)', fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>{detail.key}</span>
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>TTL: {ttlText(detail.ttl)}</span>
        {detail.memory != null && <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>· {detail.memory} bytes</span>}
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={onSetTtl} style={{ padding: '0 8px' }}>TTL</button>
        <button className="btn btn-secondary" onClick={onRename} style={{ padding: '0 8px' }}>Đổi tên</button>
        <button className="btn btn-secondary" onClick={onDelete} style={{ padding: '0 8px', color: 'var(--st-danger)' }}>Xóa</button>
      </div>

      {/* String */}
      {detail.type === 'string' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {decoded && (
              <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', background: 'rgba(77,139,244,0.15)', color: 'var(--win-accent)', fontWeight: 600 }}>
                Định dạng: {decoded.format}
              </span>
            )}
            {decoded && decoded.format !== 'raw' && (
              <label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: 'var(--win-text-secondary)' }}>
                <input type="checkbox" checked={showDecoded} onChange={(e) => setShowDecoded(e.target.checked)} /> Giải mã (decode)
              </label>
            )}
            <div style={{ flex: 1 }} />
            {!showDecoded && (
              <button className="btn btn-primary" onClick={onSave} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}><Save size={11} /> Lưu (SET)</button>
            )}
          </div>
          {showDecoded && decoded ? (
            <textarea readOnly value={decoded.text} style={monoBox} />
          ) : (
            <textarea value={editText} onChange={(e) => setEditText(e.target.value)} style={monoBox} placeholder="(giá trị rỗng)" />
          )}
          {showDecoded && (v.bytes && !v.text) && (
            <div style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>* Giá trị nhị phân — chỉ xem, sửa raw không khả dụng an toàn.</div>
          )}
        </>
      )}

      {/* Hash */}
      {detail.type === 'hash' && <KVTable rows={(v.fields || []).map((f: any) => [f.field, f.value])} cols={['Field', 'Value']} />}
      {/* List */}
      {detail.type === 'list' && <KVTable rows={(v.items || []).map((it: any, i: number) => [String(i), it])} cols={['Index', 'Value']} />}
      {/* Set */}
      {detail.type === 'set' && <KVTable rows={(v.members || []).map((m: any) => [m])} cols={['Member']} />}
      {/* ZSet */}
      {detail.type === 'zset' && <KVTable rows={(v.entries || []).map((e: any) => [String(e.score), e.member])} cols={['Score', 'Member']} />}
      {/* Stream */}
      {detail.type === 'stream' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {(v.entries || []).map((e: any, i: number) => (
            <div key={i} style={{ border: '1px solid var(--win-border)', borderRadius: '4px', padding: '8px', background: 'var(--win-bg-window)' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--win-accent)', marginBottom: '4px' }}>{e.id}</div>
              <KVTable rows={(e.fields || []).map((f: any) => [f.field, typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value)])} cols={['Field', 'Value']} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const KVTable: React.FC<{ rows: any[][]; cols: string[] }> = ({ rows, cols }) => (
  <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'auto', background: 'var(--win-bg-window)' }}>
    <table className="grid-table" style={{ width: '100%' }}>
      <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={cols.length} style={{ color: 'var(--win-text-disabled)', textAlign: 'center', padding: '10px' }}>(rỗng)</td></tr>}
        {rows.map((r, i) => (
          <tr key={i}>{r.map((cell, j) => <td key={j} style={{ fontFamily: 'var(--win-font-mono)', fontSize: '11px', wordBreak: 'break-all' }}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  </div>
);

// ---- CLI Console ----
const QUICK_CMDS = ['PING', 'INFO', 'DBSIZE', 'CLIENT LIST', 'CONFIG GET maxmemory'];

const RedisConsole: React.FC<{ onError: (t: string) => void }> = ({ onError }) => {
  const [cmd, setCmd] = useState('');
  const [log, setLog] = useState<{ cmd: string; out: string; ok: boolean }[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1); // -1 = đang gõ mới
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  const run = async (raw?: string) => {
    const command = (raw ?? cmd).trim();
    if (!command) return;
    setHistory((prev) => (prev[prev.length - 1] === command ? prev : [...prev, command]));
    setHistIdx(-1);
    setCmd('');
    const res = await dbHelper.redisExecuteCmd(command);
    const out = res.success ? JSON.stringify(res.result, null, 2) : `(error) ${res.error}`;
    if (!res.success && res.error) onError(res.error);
    setLog((prev) => [...prev, { cmd: command, out, ok: !!res.success }]);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { run(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setCmd(history[idx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === -1) return;
      const idx = histIdx + 1;
      if (idx >= history.length) { setHistIdx(-1); setCmd(''); }
      else { setHistIdx(idx); setCmd(history[idx]); }
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>Lệnh nhanh:</span>
        {QUICK_CMDS.map((q) => (
          <button key={q} onClick={() => run(q)} style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', border: '1px solid var(--win-border)', background: 'var(--win-bg-window)', color: 'var(--win-text-secondary)', cursor: 'pointer', fontFamily: 'var(--win-font-mono)' }}>{q}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => setLog([])} disabled={log.length === 0} style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'transparent', color: 'var(--win-text-secondary)', cursor: 'pointer' }}>Xóa log</button>
      </div>
      <div ref={logRef} style={{ flex: 1, overflow: 'auto', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', borderRadius: '4px', padding: '8px', fontFamily: 'var(--win-font-mono)', fontSize: '11px' }}>
        {log.length === 0 && <div style={{ color: 'var(--win-text-disabled)' }}>Gõ lệnh Redis rồi Enter: GET key, HGETALL myhash, TTL key... Dùng ↑/↓ để lặp lại lệnh cũ.</div>}
        {log.map((l, i) => (
          <div key={i} style={{ marginBottom: '8px' }}>
            <div style={{ color: 'var(--win-accent)' }}>&gt; {l.cmd}</div>
            <pre style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap', color: l.ok ? 'var(--win-text-primary)' : 'var(--st-danger)' }}>{l.out}</pre>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '6px' }}>
        <span style={{ display: 'flex', alignItems: 'center', color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)', fontSize: '13px', fontWeight: 700 }}>&gt;</span>
        <input
          ref={inputRef}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Nhập lệnh rồi Enter (↑/↓ lịch sử)..."
          spellCheck={false}
          style={{ flex: 1, background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', padding: '6px 10px', fontFamily: 'var(--win-font-mono)', fontSize: '11px', outline: 'none' }}
        />
        <button className="btn btn-primary" onClick={() => run()} style={{ padding: '0 14px', fontSize: '11px' }}>Chạy</button>
      </div>
    </div>
  );
};

// ---- Dashboard ----
const RedisDashboard: React.FC<{ onError: (t: string) => void }> = ({ onError }) => {
  const [info, setInfo] = useState<any>(null);
  const load = async () => {
    const res = await dbHelper.redisInfo();
    if (res.success) setInfo(res.info);
    else onError(res.error || 'Lỗi INFO');
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  const g = (section: string, key: string) => info?.[section]?.[key];
  const stats = [
    { label: 'Redis version', val: g('Server', 'redis_version') },
    { label: 'Uptime (ngày)', val: g('Server', 'uptime_in_days') },
    { label: 'Clients kết nối', val: g('Clients', 'connected_clients') },
    { label: 'Memory dùng', val: g('Memory', 'used_memory_human') },
    { label: 'Memory peak', val: g('Memory', 'used_memory_peak_human') },
    { label: 'Total keys (db0)', val: (g('Keyspace', 'db0') || '').toString().split(',')[0]?.replace('keys=', '') },
    { label: 'Ops/giây', val: g('Stats', 'instantaneous_ops_per_sec') },
    { label: 'Hit rate', val: (() => { const h = Number(g('Stats', 'keyspace_hits')); const m = Number(g('Stats', 'keyspace_misses')); return h + m > 0 ? `${((h / (h + m)) * 100).toFixed(1)}%` : '-'; })() },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}><Layers size={14} /> Server Dashboard</span>
        <button className="btn btn-secondary" onClick={load} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}><RefreshCw size={11} /> Làm mới</button>
      </div>
      {!info ? <div style={{ color: 'var(--win-text-disabled)', fontSize: '12px' }}>Đang tải INFO...</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' }}>
          {stats.map((s) => (
            <div key={s.label} style={{ border: '1px solid var(--win-border)', borderRadius: '6px', padding: '10px 12px', background: 'var(--win-bg-window)' }}>
              <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)' }}>{s.label}</div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--win-text-primary)', marginTop: '2px' }}>{s.val ?? '-'}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const monoBox: React.CSSProperties = {
  flex: 1, width: '100%', minHeight: '260px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)',
  color: 'var(--win-text-primary)', fontFamily: 'var(--win-font-mono)', fontSize: '12px', padding: '10px', borderRadius: '4px', resize: 'vertical', outline: 'none',
};
