import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Save, Terminal } from 'lucide-react';
import { dbHelper, type RedisValueDetail } from '../../utils/dbHelper';
import {
  REDIS_FORMATS, decodeRedisValue, parseHexDump, type DecodedRedis, type RedisFormat,
} from '../../utils/redisDecode';
import { CollectionTable } from './CollectionTable';
import { StreamPanel } from './StreamPanel';
import { TYPE_COLORS, formatBytes, monoBox, ttlText } from './shared';
import type { CollectionEditor } from './types';

interface ValuePanelProps {
  detail: RedisValueDetail;
  storageScope: string;
  readOnly: boolean;
  onRename: () => void;
  onSetTtl: () => void;
  onDelete: () => void;
  onError: (msg: string) => void;
  onOk: (msg: string) => void;
  onBlocked: () => boolean;
  onReload: () => void;
}

/** Redis' own name for a RedisJSON key. */
const REJSON_TYPE = 'ReJSON-RL';

export const ValuePanel: React.FC<ValuePanelProps> = ({
  detail, storageScope, readOnly, onRename, onSetTtl, onDelete, onError, onOk, onBlocked, onReload,
}) => {
  const { t } = useTranslation();
  const v = detail.value || {};
  const kind: string = v.kind ?? detail.type;

  const badge = (
    <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', color: '#fff', background: TYPE_COLORS[detail.type] || '#64748b', textTransform: 'uppercase' }}>
      {detail.type}
    </span>
  );

  // Element pages are handed to the table as one object so it can reset on a new key.
  const initialPage = useMemo(
    () => ({ elements: v.elements || [], cursor: v.nextCursor ?? '', done: !!v.done }),
    [v.elements, v.nextCursor, v.done],
  );

  const editor = useCollectionEditor(detail, kind, onError, onOk);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        {badge}
        <span style={{ fontFamily: 'var(--win-font-mono)', fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>{detail.key}</span>
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>TTL: {ttlText(detail.ttl)}</span>
        {detail.memory != null && (
          <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>· {formatBytes(detail.memory)}</span>
        )}
        {detail.length != null && (
          <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>
            · {t('redis.elementCount', { n: detail.length.toLocaleString() })}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={onSetTtl} disabled={readOnly} style={{ padding: '0 8px' }}>TTL</button>
        <button className="btn btn-secondary" onClick={onRename} disabled={readOnly} style={{ padding: '0 8px' }}>{t('redis.rename')}</button>
        <button className="btn btn-secondary" onClick={onDelete} disabled={readOnly} style={{ padding: '0 8px', color: 'var(--st-danger)' }}>{t('redis.delete')}</button>
      </div>

      {kind === 'string' && (
        <StringValue
          keyName={detail.key}
          value={v}
          storageScope={storageScope}
          readOnly={readOnly}
          onError={onError}
          onOk={onOk}
          onBlocked={onBlocked}
          onReload={onReload}
        />
      )}

      {editor && (
        <CollectionTable
          key={`${detail.key}#${kind}`}
          keyName={detail.key}
          editor={editor}
          initial={initialPage}
          total={detail.length}
          readOnly={readOnly}
          onError={onError}
          onBlocked={onBlocked}
        />
      )}

      {kind === 'stream' && (
        <StreamPanel
          key={detail.key}
          keyName={detail.key}
          initial={initialPage}
          total={detail.length}
          readOnly={readOnly}
          onError={onError}
          onOk={onOk}
          onBlocked={onBlocked}
        />
      )}

      {kind === 'unsupported' && (
        v.redisType === REJSON_TYPE ? (
          <JsonValue keyName={detail.key} readOnly={readOnly} onError={onError} onOk={onOk} onBlocked={onBlocked} />
        ) : (
          <UnsupportedValue redisType={String(v.redisType ?? detail.type)} />
        )
      )}
    </div>
  );
};

/** Builds the per-type editor descriptor. Each entry maps to exactly one Redis command. */
function useCollectionEditor(
  detail: RedisValueDetail,
  kind: string,
  onError: (msg: string) => void,
  onOk: (msg: string) => void,
): CollectionEditor | null {
  const { t } = useTranslation();
  const key = detail.key;

  return useMemo<CollectionEditor | null>(() => {
    const run = async (p: Promise<{ success: boolean; error?: string }>, okMsg: string) => {
      const res = await p;
      if (!res.success) { onError(res.error || t('redis.errSave')); return false; }
      onOk(okMsg);
      return true;
    };

    switch (kind) {
      case 'hash':
        return {
          kind,
          cols: [
            { label: 'Field', editable: true, placeholder: 'field', width: '32%' },
            { label: 'Value', editable: true, placeholder: 'value' },
          ],
          toRow: (el, i) => ({
            id: `f:${i}:${el.field}`,
            cells: [el.field ?? '', el.value ?? ''],
            binary: !!el.binary,
            binaryKey: !!el.binaryKey,
          }),
          serverFilter: true,
          indexShiftsOnDelete: false,
          onCommit: (cells, prev) => {
            if (!cells[0].trim()) { onError(t('redis.errEmptyField')); return Promise.resolve(false); }
            return run(dbHelper.redisHashSet(key, cells[0], cells[1], prev?.cells[0]), t('redis.savedElement'));
          },
          onDelete: (row) => run(dbHelper.redisHashDel(key, row.cells[0]), t('redis.deletedElement')),
        };

      case 'list':
        return {
          kind,
          cols: [
            { label: 'Index', editable: false, addHint: t('redis.listAppendHint'), width: '90px' },
            { label: 'Value', editable: true, placeholder: 'value' },
          ],
          // The index is absolute (baked in by the backend), which is what LSET/LREM need.
          toRow: (el, i) => ({
            id: `i:${el.index ?? i}`,
            cells: [String(el.index ?? i), el.value ?? ''],
            binary: !!el.binary,
            binaryKey: false,
          }),
          serverFilter: false,
          indexShiftsOnDelete: true,
          onCommit: (cells, prev) => (prev
            ? run(dbHelper.redisListSet(key, Number(prev.cells[0]), cells[1]), t('redis.savedElement'))
            : run(dbHelper.redisListPush(key, cells[1]), t('redis.savedElement'))),
          onDelete: (row) => run(dbHelper.redisListDel(key, Number(row.cells[0])), t('redis.deletedElement')),
        };

      case 'set':
        return {
          kind,
          cols: [{ label: 'Member', editable: true, placeholder: 'member' }],
          toRow: (el, i) => ({
            id: `m:${i}:${el.value}`,
            cells: [el.value ?? ''],
            binary: !!el.binary,
            binaryKey: !!el.binaryKey,
          }),
          serverFilter: true,
          indexShiftsOnDelete: false,
          onCommit: (cells, prev) => run(dbHelper.redisSetMember(key, cells[0], prev?.cells[0]), t('redis.savedElement')),
          onDelete: (row) => run(dbHelper.redisSetDelMember(key, row.cells[0]), t('redis.deletedElement')),
        };

      case 'zset':
        return {
          kind,
          cols: [
            { label: 'Score', editable: true, placeholder: '0', width: '120px' },
            { label: 'Member', editable: true, placeholder: 'member' },
          ],
          toRow: (el, i) => ({
            id: `z:${i}:${el.member}`,
            cells: [String(el.score ?? 0), el.member ?? ''],
            binary: !!el.binary,
            binaryKey: !!el.binaryKey,
          }),
          // ZSCAN would lose score order, so paging is by rank and the filter is local.
          serverFilter: false,
          indexShiftsOnDelete: false,
          onCommit: (cells, prev) => {
            const score = Number(cells[0]);
            if (!cells[0].trim() || Number.isNaN(score)) { onError(t('redis.errInvalidScore')); return Promise.resolve(false); }
            return run(dbHelper.redisZsetAdd(key, cells[1], score, prev?.cells[1]), t('redis.savedElement'));
          },
          onDelete: (row) => run(dbHelper.redisZsetDel(key, row.cells[1]), t('redis.deletedElement')),
        };

      default:
        return null;
    }
  }, [kind, key, onError, onOk, t]);
}

interface StringValueProps {
  keyName: string;
  value: any;
  storageScope: string;
  readOnly: boolean;
  onError: (msg: string) => void;
  onOk: (msg: string) => void;
  onBlocked: () => boolean;
  onReload: () => void;
}

/**
 * String viewer/editor with an explicit format picker.
 *
 * Two rules here protect data:
 *  - a value larger than the preview limit is **read-only**, because saving what is on screen
 *    would replace the rest of the value with nothing;
 *  - text editing is only offered when the bytes are valid UTF-8. Binary values are edited
 *    through the hex view, which writes raw bytes (`redis_set_key_bytes`) and therefore
 *    round-trips exactly.
 */
const StringValue: React.FC<StringValueProps> = ({
  keyName, value, storageScope, readOnly, onError, onOk, onBlocked, onReload,
}) => {
  const { t } = useTranslation();
  const formatKey = `tf_redis_format_${storageScope}`;
  const [format, setFormat] = useState<RedisFormat>(() => {
    const saved = localStorage.getItem(formatKey) as RedisFormat | null;
    return saved && REDIS_FORMATS.includes(saved) ? saved : 'auto';
  });
  const [decoded, setDecoded] = useState<DecodedRedis | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // Held as the raw prop, not `value.bytes || []`: a fresh `[]` on every render would make the
  // decode effect below re-run forever and overwrite the text being edited.
  const rawBytes: number[] | undefined = value.bytes;
  const isBinary = value.text == null;
  const truncated = !!value.truncated;

  useEffect(() => { localStorage.setItem(formatKey, format); }, [format, formatKey]);

  useEffect(() => {
    let alive = true;
    decodeRedisValue(rawBytes ?? [], format).then((d) => {
      if (!alive) return;
      setDecoded(d);
      setDraft(d.text);
    });
    return () => { alive = false; };
  }, [rawBytes, format]);

  // Raw text and hex are the two editable views; everything else is a projection that cannot
  // be written back unambiguously.
  //
  // `auto` is only editable when it *landed* on raw, i.e. what is on screen is what the key holds.
  // Sniffing igbinary/php-serialize/JSON, or decompressing, all put a projection in the box, and
  // saving that would write the projection over the value — `isBinary` does not catch it, because
  // a short igbinary blob can be valid UTF-8. Editing those means picking `raw` (or `hex`).
  const autoShowsStoredBytes = decoded?.format === 'raw';
  const editableText =
    !readOnly && !truncated && !isBinary
    && (format === 'raw' || (format === 'auto' && autoShowsStoredBytes));
  const editableHex = !readOnly && !truncated && format === 'hex';

  const saveText = async () => {
    if (onBlocked()) return;
    setSaving(true);
    const res = await dbHelper.redisSetKey({ key: keyName, kind: 'string', value: draft });
    setSaving(false);
    if (!res.success) { onError(res.error || t('redis.errSave')); return; }
    onOk(t('redis.savedValue'));
    onReload();
  };

  const saveHex = async () => {
    if (onBlocked()) return;
    let parsed: Uint8Array;
    try {
      parsed = parseHexDump(draft);
    } catch (e: any) {
      onError(String(e?.message ?? e));
      return;
    }
    setSaving(true);
    const res = await dbHelper.redisSetKeyBytes(keyName, Array.from(parsed));
    setSaving(false);
    if (!res.success) { onError(res.error || t('redis.errSave')); return; }
    onOk(t('redis.savedValue'));
    onReload();
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', color: 'var(--win-text-secondary)' }}>{t('redis.formatLabel')}</span>
        <select
          value={format}
          onChange={(e) => setFormat(e.target.value as RedisFormat)}
          style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '10px', padding: '2px 4px' }}
        >
          {REDIS_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        {decoded && (
          <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', background: 'rgba(77,139,244,0.15)', color: 'var(--win-accent)', fontWeight: 600 }}>
            {t('redis.format', { format: decoded.format })}
          </span>
        )}
        {decoded && !decoded.ok && (
          <span style={{ fontSize: '10px', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <AlertTriangle size={11} /> {t('redis.formatMismatch')}
          </span>
        )}
        {value.totalLength != null && (
          <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>
            {t('redis.stringLength', { n: Number(value.totalLength).toLocaleString() })}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {editableText && (
          <button className="btn btn-primary" onClick={saveText} disabled={saving} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Save size={11} /> {t('redis.saveSet')}
          </button>
        )}
        {editableHex && (
          <button className="btn btn-primary" onClick={saveHex} disabled={saving} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Save size={11} /> {t('redis.saveHex')}
          </button>
        )}
      </div>

      {truncated && (
        <div style={{ padding: '6px 8px', borderRadius: '4px', background: 'rgba(245,158,11,0.12)', color: '#f59e0b', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <AlertTriangle size={12} /> {t('redis.truncatedNote')}
        </div>
      )}

      <textarea
        value={draft}
        readOnly={!editableText && !editableHex}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        style={monoBox}
        placeholder={t('redis.emptyValuePlaceholder')}
      />

      {isBinary && !truncated && (
        <div style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.binaryHexNote')}</div>
      )}
    </>
  );
};

interface JsonValueProps {
  keyName: string;
  readOnly: boolean;
  onError: (msg: string) => void;
  onOk: (msg: string) => void;
  onBlocked: () => boolean;
}

/** RedisJSON key: read/write a path with JSON.GET / JSON.SET. */
const JsonValue: React.FC<JsonValueProps> = ({ keyName, readOnly, onError, onOk, onBlocked }) => {
  const { t } = useTranslation();
  const [path, setPath] = useState('$');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    const res = await dbHelper.redisJsonGet(keyName, p);
    setLoading(false);
    if (!res.success) { onError(res.error || t('redis.errReadKey')); return; }
    setText(res.json ?? '');
  }, [keyName, onError, t]);

  useEffect(() => { load('$'); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [keyName]);

  const save = async () => {
    if (onBlocked()) return;
    // Fail before touching the server: JSON.SET would reject it anyway, with a driver message.
    try {
      JSON.parse(text);
    } catch {
      onError(t('redis.errInvalidJson'));
      return;
    }
    const res = await dbHelper.redisJsonSet(keyName, path, text);
    if (!res.success) { onError(res.error || t('redis.errSave')); return; }
    onOk(t('redis.savedValue'));
    load(path);
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', color: 'var(--win-text-secondary)' }}>{t('redis.jsonPath')}</span>
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(path); }}
          spellCheck={false}
          style={{ width: '180px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '11px', fontFamily: 'var(--win-font-mono)', padding: '3px 6px' }}
        />
        <button className="btn btn-secondary" onClick={() => load(path)} disabled={loading} style={{ padding: '0 10px' }}>
          {loading ? t('redis.loading') : t('redis.jsonLoadPath')}
        </button>
        <div style={{ flex: 1 }} />
        {!readOnly && (
          <button className="btn btn-primary" onClick={save} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Save size={11} /> {t('redis.jsonSave')}
          </button>
        )}
      </div>
      <textarea
        value={text}
        readOnly={readOnly}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        style={monoBox}
      />
    </>
  );
};

/**
 * A type the app has no editor for (vector set, TimeSeries, a probabilistic type…).
 * Previously these rendered as an empty panel with no explanation at all.
 */
const UnsupportedValue: React.FC<{ redisType: string }> = ({ redisType }) => {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px', border: '1px dashed var(--win-border)', borderRadius: '6px', background: 'var(--win-bg-window)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
        <AlertTriangle size={14} style={{ color: '#f59e0b' }} />
        {t('redis.unsupportedType', { type: redisType })}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.6 }}>
        {t('redis.unsupportedHint')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-disabled)' }}>
        <Terminal size={12} /> {t('redis.unsupportedConsoleHint')}
      </div>
    </div>
  );
};
