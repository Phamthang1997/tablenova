import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, RefreshCw, Plus, Trash2, Key, Clock, Terminal, Activity,
  Save, Database, AlertTriangle, CheckCircle2, Layers, LogOut, Square,
  Pencil, Check, X, Lock,
} from 'lucide-react';
import { dbHelper, type RedisKeyItem, type RedisValueDetail, type RedisEditResult } from '../utils/dbHelper';
import { decodeRedisValue, type DecodedRedis } from '../utils/redisDecode';

interface RedisBrowserProps {
  dbName: string;
  initialDbIndex?: number;
  onDisconnect: () => void;
  /** Chế độ chỉ đọc: chặn mọi lệnh ghi (SET/DEL/FLUSHDB/EXPIRE/RENAME + sửa phần tử). */
  readOnly?: boolean;
}

/** Một cột của bảng sửa collection. */
interface CollColumn {
  label: string;
  editable: boolean;
  /** Hiển thị thay cho input ở dòng "thêm mới" khi cột không sửa được (vd Index của list). */
  addHint?: string;
  placeholder?: string;
  width?: string;
}

interface CollRow {
  id: string;
  cells: string[];
  /** Giá trị gốc không phải UTF-8 -> `cells` đã bị lossy-convert, không được ghi lại. */
  binary?: boolean;
}

/**
 * Mô tả cách sửa một collection (hash/list/set/zset). `CollectionTable` chỉ lo phần UI;
 * mỗi kiểu tự khai báo cột + hai lệnh commit/delete của mình trong `buildEditor()`.
 */
interface CollectionEditor {
  cols: CollColumn[];
  rows: CollRow[];
  /**
   * true nếu lệnh xóa định danh phần tử bằng chính giá trị (SREM/ZREM) — với phần tử nhị phân
   * chuỗi lossy sẽ không khớp bytes thật nên phải chặn luôn cả xóa. Hash (HDEL theo field) và
   * list (LREM theo index) không bị ảnh hưởng.
   */
  binaryBlocksDelete: boolean;
  /** prev = null -> thêm phần tử mới. Trả về true nếu ghi thành công (để bảng đóng ô sửa). */
  onCommit: (cells: string[], prev: CollRow | null) => Promise<boolean>;
  onDelete: (row: CollRow) => Promise<boolean>;
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

export const RedisBrowser: React.FC<RedisBrowserProps> = ({ dbName, initialDbIndex = 0, onDisconnect, readOnly = false }) => {
  const { t } = useTranslation();
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

  // Chặn thao tác ghi khi bật Chỉ đọc. `runEdit` cũng gọi hàm này nên toàn bộ phần sửa
  // collection/stream được phủ bởi một chốt duy nhất.
  const blockedByReadOnly = (): boolean => {
    if (!readOnly) return false;
    flash('err', t('redis.errReadOnly'));
    return true;
  };

  // ---- SCAN keys (streaming) ----
  // Vừa SCAN vừa nhận batch qua Channel -> danh sách tự đầy dần. Lọc client-side theo type
  // (server có thể không hỗ trợ SCAN TYPE). Truyền pattern/type tường minh tránh stale-closure.
  const startScan = (pat: string, type: string) => {
    if (scanIdRef.current) dbHelper.cancelQuery(scanIdRef.current); // dừng scan cũ nếu đang chạy
    const id = `rscan_${crypto.randomUUID()}`;
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
        flash('err', msg.message || t('redis.errScan'));
      }
    }).catch((e) => { setStreaming(false); flash('err', String(e)); });
  };

  const stopScan = () => { if (scanIdRef.current) dbHelper.cancelQuery(scanIdRef.current); setStreaming(false); };
  const refresh = () => startScan(pattern, typeFilter);
  // Not named `t` — that is the translation function.
  const onChangeTypeFilter = (type: string) => { setTypeFilter(type); startScan(pattern, type); };

  // Tải lần đầu + khi đổi db index.
  useEffect(() => { startScan(pattern, typeFilter); /* eslint-disable-next-line */ }, [dbIndex]);

  // ---- Chọn key -> lấy chi tiết ----
  const applyDetail = async (d: RedisValueDetail) => {
    setDetail(d);
    if (d.type === 'string') {
      const v = d.value || {};
      setEditText(v.text ?? '');
      const dec = await decodeRedisValue(v.bytes || []);
      setDecoded(dec);
      // Giá trị nhị phân (text == null): luôn mở khung đã giải mã, vì khung sửa raw bị chặn.
      setShowDecoded(dec.format !== 'raw' || v.text == null);
    } else {
      setDecoded(null);
    }
  };

  const selectKey = async (key: string) => {
    setSelectedKey(key);
    setRightTab('value');
    setDetail(null);
    setDecoded(null);
    const d = await dbHelper.redisGetKey(key);
    if (!d.success) { flash('err', d.message || t('redis.errReadKey')); return; }
    await applyDetail(d);
  };

  // Nạp lại sau khi sửa, KHÔNG xóa `detail` trước (tránh nháy sang khung "chọn một key").
  const reloadDetail = async () => {
    if (!selectedKey) return;
    const d = await dbHelper.redisGetKey(selectedKey);
    if (!d.success) {
      // Xóa phần tử cuối cùng -> Redis tự xóa key luôn. Bỏ chọn thay vì báo "key không tồn tại".
      setKeys((prev) => prev.filter((k) => k.key !== selectedKey));
      setSelectedKey(null);
      setDetail(null);
      setDecoded(null);
      return;
    }
    await applyDetail(d);
  };

  // Chạy một lệnh sửa phần tử: flash kết quả + nạp lại chi tiết key.
  const runEdit = async (p: Promise<RedisEditResult>, okKey: 'redis.savedElement' | 'redis.deletedElement') => {
    if (blockedByReadOnly()) return false;
    const res = await p;
    if (!res.success) { flash('err', res.error || t('redis.errSave')); return false; }
    flash('ok', t(okKey));
    await reloadDetail();
    return true;
  };

  const handleSelectDb = async (idx: number) => {
    const res = await dbHelper.redisSelectDb(idx);
    if (res.success) { setDbIndex(idx); setSelectedKey(null); setDetail(null); }
    else flash('err', res.error || t('redis.errSelectDb'));
  };

  const handleDeleteKey = async (key: string) => {
    if (blockedByReadOnly()) return;
    if (!confirm(t('redis.confirmDeleteKey', { key }))) return;
    const res = await dbHelper.redisDeleteKeys([key]);
    if (res.success) {
      flash('ok', t('redis.deletedKey', { key }));
      setKeys((prev) => prev.filter((k) => k.key !== key));
      if (selectedKey === key) { setSelectedKey(null); setDetail(null); }
    } else flash('err', res.error || t('redis.errDelete'));
  };

  const handleNewKey = async () => {
    if (blockedByReadOnly()) return;
    const name = prompt(t('redis.promptNewKey'));
    if (!name) return;
    const res = await dbHelper.redisSetKey({ key: name, kind: 'string', value: '' });
    if (res.success) { flash('ok', t('redis.createdKey', { key: name })); refresh(); selectKey(name); }
    else flash('err', res.error || t('redis.errCreate'));
  };

  const handleFlush = async () => {
    if (blockedByReadOnly()) return;
    if (!confirm(t('redis.flushDbConfirm', { db: dbIndex }))) return;
    const res = await dbHelper.redisFlushDb();
    if (res.success) { flash('ok', t('redis.flushDbOk')); refresh(); setSelectedKey(null); setDetail(null); }
    else flash('err', res.error || t('redis.errFlushDb'));
  };

  const handleSaveString = async () => {
    if (!selectedKey) return;
    if (blockedByReadOnly()) return;
    const res = await dbHelper.redisSetKey({ key: selectedKey, kind: 'string', value: editText });
    if (res.success) { flash('ok', t('redis.savedValue')); selectKey(selectedKey); }
    else flash('err', res.error || t('redis.errSave'));
  };

  const handleRename = async () => {
    if (!selectedKey) return;
    if (blockedByReadOnly()) return;
    const nw = prompt(t('redis.promptRename'), selectedKey);
    if (!nw || nw === selectedKey) return;
    const res = await dbHelper.redisRenameKey(selectedKey, nw);
    if (res.success) { flash('ok', t('redis.renamed')); refresh(); setSelectedKey(nw); selectKey(nw); }
    else flash('err', res.error || t('redis.errRename'));
  };

  const handleSetTtl = async () => {
    if (!selectedKey) return;
    if (blockedByReadOnly()) return;
    const s = prompt(t('redis.promptTtl'), String(detail?.ttl ?? -1));
    if (s === null) return;
    const ttl = parseInt(s, 10);
    if (Number.isNaN(ttl)) return;
    const res = await dbHelper.redisSetTtl(selectedKey, ttl);
    if (res.success) { flash('ok', t('redis.ttlSet')); selectKey(selectedKey); }
    else flash('err', res.error || t('redis.errTtl'));
  };

  // ---- Sửa collection ----
  // Mỗi thao tác = đúng một lệnh Redis (HSET/LSET/SADD/ZADD/...). Không dùng redisSetKey ở đây:
  // lệnh đó là REPLACE (DEL rồi dựng lại) nên sẽ mất TTL và ghi lại toàn bộ phần tử của key.
  const buildEditor = (): CollectionEditor | null => {
    if (!detail) return null;
    const key = detail.key;
    const v = detail.value || {};

    switch (detail.type) {
      case 'hash':
        return {
          cols: [
            { label: 'Field', editable: true, placeholder: 'field', width: '32%' },
            { label: 'Value', editable: true, placeholder: 'value' },
          ],
          rows: (v.fields || []).map((f: any) => ({ id: `f:${f.field}`, cells: [f.field ?? '', f.value ?? ''], binary: !!f.binary })),
          binaryBlocksDelete: false,
          onCommit: (cells, prev) => {
            if (!cells[0].trim()) { flash('err', t('redis.errEmptyField')); return Promise.resolve(false); }
            return runEdit(dbHelper.redisHashSet(key, cells[0], cells[1], prev?.cells[0]), 'redis.savedElement');
          },
          onDelete: (row) => runEdit(dbHelper.redisHashDel(key, row.cells[0]), 'redis.deletedElement'),
        };

      case 'list':
        return {
          cols: [
            { label: 'Index', editable: false, addHint: t('redis.listAppendHint'), width: '90px' },
            { label: 'Value', editable: true, placeholder: 'value' },
          ],
          rows: (v.items || []).map((it: any, i: number) => ({ id: `i:${i}`, cells: [String(i), it?.value ?? ''], binary: !!it?.binary })),
          binaryBlocksDelete: false,
          onCommit: (cells, prev) => prev
            ? runEdit(dbHelper.redisListSet(key, Number(prev.cells[0]), cells[1]), 'redis.savedElement')
            : runEdit(dbHelper.redisListPush(key, cells[1]), 'redis.savedElement'),
          onDelete: (row) => runEdit(dbHelper.redisListDel(key, Number(row.cells[0])), 'redis.deletedElement'),
        };

      case 'set':
        return {
          cols: [{ label: 'Member', editable: true, placeholder: 'member' }],
          rows: (v.members || []).map((m: any) => ({ id: `m:${m?.value}`, cells: [m?.value ?? ''], binary: !!m?.binary })),
          binaryBlocksDelete: true,
          onCommit: (cells, prev) => runEdit(dbHelper.redisSetMember(key, cells[0], prev?.cells[0]), 'redis.savedElement'),
          onDelete: (row) => runEdit(dbHelper.redisSetDelMember(key, row.cells[0]), 'redis.deletedElement'),
        };

      case 'zset':
        return {
          cols: [
            { label: 'Score', editable: true, placeholder: '0', width: '120px' },
            { label: 'Member', editable: true, placeholder: 'member' },
          ],
          rows: (v.entries || []).map((e: any) => ({ id: `z:${e.member}`, cells: [String(e.score ?? 0), e.member ?? ''], binary: !!e.binary })),
          binaryBlocksDelete: true,
          onCommit: (cells, prev) => {
            const score = Number(cells[0]);
            if (!cells[0].trim() || Number.isNaN(score)) { flash('err', t('redis.errInvalidScore')); return Promise.resolve(false); }
            return runEdit(dbHelper.redisZsetAdd(key, cells[1], score, prev?.cells[1]), 'redis.savedElement');
          },
          onDelete: (row) => runEdit(dbHelper.redisZsetDel(key, row.cells[1]), 'redis.deletedElement'),
        };

      default:
        return null;
    }
  };

  // Stream: entry là immutable trong Redis -> chỉ có thêm (XADD) và xóa (XDEL).
  const handleStreamAdd = async (id: string, fields: { field: string; value: string }[]) => {
    if (!selectedKey) return false;
    const clean = fields.filter((f) => f.field.trim() !== '');
    if (clean.length === 0) { flash('err', t('redis.errStreamNoField')); return false; }
    return runEdit(dbHelper.redisStreamAdd(selectedKey, id, clean), 'redis.savedElement');
  };

  const handleStreamDel = async (id: string) => {
    if (!selectedKey) return false;
    return runEdit(dbHelper.redisStreamDel(selectedKey, id), 'redis.deletedElement');
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
              title={t('redis.dbIndexTitle')}
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
            <select value={typeFilter} onChange={(e) => onChangeTypeFilter(e.target.value)} title={t('redis.filterByTypeTitle')} style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '10px' }}>
              <option value="">{t('redis.allTypes')}</option>
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
              <button className="btn btn-secondary" onClick={stopScan} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', color: 'var(--st-danger)' }}><Square size={10} /> {t('redis.stopScan')}</button>
            ) : (
              <button className="btn btn-secondary" onClick={refresh} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}><RefreshCw size={11} /> {t('redis.refresh')}</button>
            )}
            <button className="btn btn-secondary" onClick={handleNewKey} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}><Plus size={11} /> {t('redis.newKey')}</button>
            <button className="btn btn-secondary" onClick={handleFlush} title="FLUSHDB" style={{ width: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--st-danger)' }}><Trash2 size={11} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {keys.length === 0 && !streaming && (
            <div style={{ padding: '20px', textAlign: 'center', fontSize: '11px', color: 'var(--win-text-disabled)' }}>{t('redis.noKeyMatch')}</div>
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
          {streaming && <div style={{ padding: '10px', textAlign: 'center', fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('redis.scanning', { n: keys.length })}</div>}
        </div>
        <div style={{ padding: '6px 10px', borderTop: '1px solid var(--win-border)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>
            {streaming ? t('redis.keyCountScanning', { n: keys.length }) : t('redis.keyCount', { n: keys.length })}
          </div>
          <button
            className="btn btn-secondary"
            onClick={onDisconnect}
            style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}
          >
            <LogOut size={13} />
            <span>{t('redis.disconnect')}</span>
          </button>
        </div>
      </div>

      {/* ===== Right: value / console / dashboard ===== */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-tab-bar)' }}>
          {([
            ['value', t('redis.tabValue'), Key],
            ['console', t('redis.tabConsole'), Terminal],
            ['dashboard', t('redis.tabDashboard'), Activity],
          ] as const).map(([id, label, Icon]) => (
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
                {t('redis.pickKeyHint')}
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
                editor={buildEditor()}
                onStreamAdd={handleStreamAdd}
                onStreamDelete={handleStreamDel}
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
const ValuePanel: React.FC<any> = ({ detail, decoded, showDecoded, setShowDecoded, editText, setEditText, onSave, onRename, onSetTtl, onDelete, badge, editor, onStreamAdd, onStreamDelete }) => {
  const { t } = useTranslation();
  const v = detail.value || {};
  // Chuỗi nhị phân: backend trả text = null. Chỉ cho xem — SET lại chuỗi lossy sẽ thay bytes
  // thật bằng U+FFFD, nên khung sửa và nút Save đều bị tắt.
  const binaryString = detail.type === 'string' && v.text == null;
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
        <button className="btn btn-secondary" onClick={onRename} style={{ padding: '0 8px' }}>{t('redis.rename')}</button>
        <button className="btn btn-secondary" onClick={onDelete} style={{ padding: '0 8px', color: 'var(--st-danger)' }}>{t('redis.delete')}</button>
      </div>

      {/* String */}
      {detail.type === 'string' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {decoded && (
              <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', background: 'rgba(77,139,244,0.15)', color: 'var(--win-accent)', fontWeight: 600 }}>
                {t('redis.format', { format: decoded.format })}
              </span>
            )}
            {decoded && decoded.format !== 'raw' && !binaryString && (
              <label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: 'var(--win-text-secondary)' }}>
                <input type="checkbox" checked={showDecoded} onChange={(e) => setShowDecoded(e.target.checked)} /> {t('redis.decode')}
              </label>
            )}
            <div style={{ flex: 1 }} />
            {!showDecoded && !binaryString && (
              <button className="btn btn-primary" onClick={onSave} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}><Save size={11} /> {t('redis.saveSet')}</button>
            )}
          </div>
          {(showDecoded || binaryString) && decoded ? (
            <textarea readOnly value={decoded.text} style={monoBox} />
          ) : (
            <textarea value={editText} onChange={(e) => setEditText(e.target.value)} style={monoBox} placeholder={t('redis.emptyValuePlaceholder')} />
          )}
          {binaryString && (
            <div style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.binaryNote')}</div>
          )}
        </>
      )}

      {/* Hash / List / Set / ZSet — sửa từng phần tử tại chỗ.
          key={detail.key + detail.type}: đổi key phải reset ô đang sửa của bảng. */}
      {editor && <CollectionTable key={`${detail.key}#${detail.type}`} editor={editor} />}

      {/* Stream — entry không sửa được, chỉ thêm/xóa */}
      {detail.type === 'stream' && (
        <StreamEditor
          key={detail.key}
          entries={v.entries || []}
          onAdd={onStreamAdd}
          onDelete={onStreamDelete}
        />
      )}
    </div>
  );
};

// ---- Bảng sửa collection ----
// Sửa tại chỗ theo dòng: bấm ✎ (hoặc double-click) -> dòng đổi thành input, Enter lưu, Esc hủy.
// Dòng nhị phân bị khóa để chuỗi lossy không ghi đè bytes thật.
const CollectionTable: React.FC<{ editor: CollectionEditor }> = ({ editor }) => {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const firstEditable = editor.cols.findIndex((c) => c.editable);

  const startEdit = (row: CollRow) => { setAdding(false); setEditingId(row.id); setDraft([...row.cells]); };
  const startAdd = () => { setEditingId(null); setAdding(true); setDraft(editor.cols.map(() => '')); };
  const cancel = () => { setEditingId(null); setAdding(false); setDraft([]); };

  const commit = async (prev: CollRow | null) => {
    if (busy) return;
    setBusy(true);
    const ok = await editor.onCommit(draft, prev);
    setBusy(false);
    if (ok) cancel();
  };

  const remove = async (row: CollRow) => {
    if (busy) return;
    if (!confirm(t('redis.confirmDeleteElement'))) return;
    setBusy(true);
    await editor.onDelete(row);
    setBusy(false);
    cancel();
  };

  const draftCells = (prev: CollRow | null) => editor.cols.map((col, i) => (
    <td key={i} style={cellStyle}>
      {col.editable ? (
        <input
          autoFocus={i === firstEditable}
          value={draft[i] ?? ''}
          onChange={(e) => setDraft((d) => d.map((val, j) => (j === i ? e.target.value : val)))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(prev); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          placeholder={col.placeholder}
          spellCheck={false}
          style={inlineInput}
        />
      ) : (
        <span style={{ color: 'var(--win-text-disabled)' }}>{prev ? prev.cells[i] : col.addHint}</span>
      )}
    </td>
  ));

  const iconBtn = (title: string, Icon: typeof Pencil, onClick: () => void, color?: string) => (
    <button
      title={title}
      onClick={onClick}
      disabled={busy}
      style={{
        background: 'transparent', border: 'none', padding: '2px', cursor: busy ? 'default' : 'pointer',
        color: color || 'var(--win-text-secondary)', display: 'flex', alignItems: 'center', opacity: busy ? 0.5 : 1,
      }}
    >
      <Icon size={12} />
    </button>
  );

  const editActions = (prev: CollRow | null) => (
    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
      <div style={{ display: 'flex', gap: '2px' }}>
        {iconBtn(t('common.save'), Check, () => commit(prev), 'var(--win-accent)')}
        {iconBtn(t('common.cancel'), X, cancel)}
      </div>
    </td>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.elementCount', { n: editor.rows.length })}</span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={startAdd} disabled={adding || busy} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Plus size={11} /> {t('redis.addElement')}
        </button>
      </div>
      <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'auto', background: 'var(--win-bg-window)' }}>
        <table className="grid-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              {editor.cols.map((c) => <th key={c.label} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}
              <th style={{ width: '58px' }} />
            </tr>
          </thead>
          <tbody>
            {editor.rows.length === 0 && !adding && (
              <tr><td colSpan={editor.cols.length + 1} style={{ color: 'var(--win-text-disabled)', textAlign: 'center', padding: '10px' }}>{t('redis.emptyCollection')}</td></tr>
            )}
            {editor.rows.map((row) => (
              editingId === row.id ? (
                <tr key={row.id}>
                  {draftCells(row)}
                  {editActions(row)}
                </tr>
              ) : (
                <tr key={row.id} onDoubleClick={() => { if (!row.binary) startEdit(row); }}>
                  {row.cells.map((cell, j) => (
                    <td key={j} style={cellStyle}>
                      {row.binary && j === row.cells.length - 1 && (
                        <Lock size={9} style={{ marginRight: '4px', verticalAlign: 'middle', color: 'var(--win-text-disabled)' }} />
                      )}
                      {cell}
                    </td>
                  ))}
                  <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: '2px' }}>
                      {row.binary
                        ? <span title={t('redis.binaryCell')} style={{ color: 'var(--win-text-disabled)', display: 'flex', alignItems: 'center', padding: '2px' }}><Lock size={12} /></span>
                        : iconBtn(t('redis.edit'), Pencil, () => startEdit(row), 'var(--win-accent)')}
                      {(!row.binary || !editor.binaryBlocksDelete) && iconBtn(t('redis.delete'), Trash2, () => remove(row), 'var(--st-danger)')}
                    </div>
                  </td>
                </tr>
              )
            ))}
            {adding && (
              <tr>
                {draftCells(null)}
                {editActions(null)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ---- Stream ----
// XADD / XDEL: Redis không có lệnh sửa một entry đã ghi, nên entry chỉ xem được.
const StreamEditor: React.FC<{
  entries: any[];
  onAdd: (id: string, fields: { field: string; value: string }[]) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}> = ({ entries, onAdd, onDelete }) => {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState('');
  const [fields, setFields] = useState<{ field: string; value: string }[]>([{ field: '', value: '' }]);
  const [busy, setBusy] = useState(false);

  const reset = () => { setAdding(false); setNewId(''); setFields([{ field: '', value: '' }]); };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await onAdd(newId, fields);
    setBusy(false);
    if (ok) reset();
  };

  const remove = async (id: string) => {
    if (busy || !confirm(t('redis.confirmDeleteElement'))) return;
    setBusy(true);
    await onDelete(id);
    setBusy(false);
  };

  const patch = (i: number, part: Partial<{ field: string; value: string }>) =>
    setFields((prev) => prev.map((f, j) => (j === i ? { ...f, ...part } : f)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.streamImmutable')}</span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={() => setAdding(true)} disabled={adding || busy} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Plus size={11} /> {t('redis.streamAddEntry')}
        </button>
      </div>

      {adding && (
        <div style={{ border: '1px solid var(--win-accent)', borderRadius: '4px', padding: '8px', background: 'var(--win-bg-window)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder={t('redis.streamIdPlaceholder')}
            spellCheck={false}
            style={{ ...inlineInput, border: '1px solid var(--win-border)', borderRadius: '3px', padding: '4px 6px' }}
          />
          {fields.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: '4px' }}>
              <input value={f.field} onChange={(e) => patch(i, { field: e.target.value })} placeholder="field" spellCheck={false} style={{ ...inlineInput, flex: '0 0 32%', border: '1px solid var(--win-border)', borderRadius: '3px', padding: '4px 6px' }} />
              <input value={f.value} onChange={(e) => patch(i, { value: e.target.value })} placeholder="value" spellCheck={false} style={{ ...inlineInput, flex: 1, border: '1px solid var(--win-border)', borderRadius: '3px', padding: '4px 6px' }} />
              <button
                onClick={() => setFields((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))}
                disabled={fields.length === 1}
                title={t('redis.delete')}
                style={{ background: 'transparent', border: 'none', color: 'var(--st-danger)', cursor: fields.length === 1 ? 'default' : 'pointer', opacity: fields.length === 1 ? 0.4 : 1, padding: '0 2px' }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button className="btn btn-secondary" onClick={() => setFields((prev) => [...prev, { field: '', value: '' }])} style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Plus size={10} /> {t('redis.streamAddField')}
            </button>
            <div style={{ flex: 1 }} />
            <button className="btn btn-secondary" onClick={reset} disabled={busy} style={{ padding: '0 10px' }}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={submit} disabled={busy} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}><Save size={11} /> {t('common.save')}</button>
          </div>
        </div>
      )}

      {entries.length === 0 && !adding && (
        <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>{t('redis.emptyCollection')}</div>
      )}
      {entries.map((e: any, i: number) => (
        <div key={e.id ?? i} style={{ border: '1px solid var(--win-border)', borderRadius: '4px', padding: '8px', background: 'var(--win-bg-window)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{e.id}</span>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => remove(e.id)}
              disabled={busy}
              title={t('redis.delete')}
              style={{ background: 'transparent', border: 'none', color: 'var(--st-danger)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, padding: '2px', display: 'flex' }}
            >
              <Trash2 size={12} />
            </button>
          </div>
          <KVTable
            rows={(e.fields || []).map((f: any) => [f.field, typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value)])}
            cols={['Field', 'Value']}
          />
        </div>
      ))}
    </div>
  );
};

const KVTable: React.FC<{ rows: any[][]; cols: string[] }> = ({ rows, cols }) => {
  const { t } = useTranslation();
  return (
    <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'auto', background: 'var(--win-bg-window)' }}>
      <table className="grid-table" style={{ width: '100%' }}>
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={cols.length} style={{ color: 'var(--win-text-disabled)', textAlign: 'center', padding: '10px' }}>{t('redis.emptyCollection')}</td></tr>}
          {rows.map((r, i) => (
            <tr key={i}>{r.map((cell, j) => <td key={j} style={cellStyle}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const cellStyle: React.CSSProperties = {
  fontFamily: 'var(--win-font-mono)', fontSize: '11px', wordBreak: 'break-all', verticalAlign: 'middle',
};

const inlineInput: React.CSSProperties = {
  width: '100%', background: 'var(--win-bg-card)', border: '1px solid var(--win-accent)',
  borderRadius: '3px', color: 'var(--win-text-primary)', fontFamily: 'var(--win-font-mono)', fontSize: '11px',
  padding: '2px 4px', outline: 'none',
};

// ---- CLI Console ----
const QUICK_CMDS = ['PING', 'INFO', 'DBSIZE', 'CLIENT LIST', 'CONFIG GET maxmemory'];

const RedisConsole: React.FC<{ onError: (msg: string) => void }> = ({ onError }) => {
  const { t } = useTranslation();
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
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.quickCommands')}</span>
        {QUICK_CMDS.map((q) => (
          <button key={q} onClick={() => run(q)} style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', border: '1px solid var(--win-border)', background: 'var(--win-bg-window)', color: 'var(--win-text-secondary)', cursor: 'pointer', fontFamily: 'var(--win-font-mono)' }}>{q}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => setLog([])} disabled={log.length === 0} style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'transparent', color: 'var(--win-text-secondary)', cursor: 'pointer' }}>{t('redis.clearLog')}</button>
      </div>
      <div ref={logRef} style={{ flex: 1, overflow: 'auto', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', borderRadius: '4px', padding: '8px', fontFamily: 'var(--win-font-mono)', fontSize: '11px' }}>
        {log.length === 0 && <div style={{ color: 'var(--win-text-disabled)' }}>{t('redis.consoleHint')}</div>}
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
          placeholder={t('redis.consolePlaceholder')}
          spellCheck={false}
          style={{ flex: 1, background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', padding: '6px 10px', fontFamily: 'var(--win-font-mono)', fontSize: '11px', outline: 'none' }}
        />
        <button className="btn btn-primary" onClick={() => run()} style={{ padding: '0 14px', fontSize: '11px' }}>{t('redis.runCommand')}</button>
      </div>
    </div>
  );
};

// ---- Dashboard ----
const RedisDashboard: React.FC<{ onError: (msg: string) => void }> = ({ onError }) => {
  const { t } = useTranslation();
  const [info, setInfo] = useState<any>(null);
  const load = async () => {
    const res = await dbHelper.redisInfo();
    if (res.success) setInfo(res.info);
    else onError(res.error || t('redis.errInfo'));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  const g = (section: string, key: string) => info?.[section]?.[key];
  const stats = [
    { label: 'Redis version', val: g('Server', 'redis_version') },
    { label: t('redis.statUptime'), val: g('Server', 'uptime_in_days') },
    { label: t('redis.statClients'), val: g('Clients', 'connected_clients') },
    { label: t('redis.statMemory'), val: g('Memory', 'used_memory_human') },
    { label: 'Memory peak', val: g('Memory', 'used_memory_peak_human') },
    { label: 'Total keys (db0)', val: (g('Keyspace', 'db0') || '').toString().split(',')[0]?.replace('keys=', '') },
    { label: t('redis.statOps'), val: g('Stats', 'instantaneous_ops_per_sec') },
    { label: 'Hit rate', val: (() => { const h = Number(g('Stats', 'keyspace_hits')); const m = Number(g('Stats', 'keyspace_misses')); return h + m > 0 ? `${((h / (h + m)) * 100).toFixed(1)}%` : '-'; })() },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}><Layers size={14} /> Server Dashboard</span>
        <button className="btn btn-secondary" onClick={load} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}><RefreshCw size={11} /> {t('redis.refresh')}</button>
      </div>
      {!info ? <div style={{ color: 'var(--win-text-disabled)', fontSize: '12px' }}>{t('redis.loadingInfo')}</div> : (
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
