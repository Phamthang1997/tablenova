import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Lock, Pencil, Plus, Trash2, X, Search } from 'lucide-react';
import { dbHelper } from '../../utils/dbHelper';
import { ConfirmDialog } from '../ConfirmDialog';
import { ELEMENT_PAGE, cellStyle, inlineInput } from './shared';
import type { CollRow, CollectionEditor } from './types';

interface CollectionTableProps {
  keyName: string;
  editor: CollectionEditor;
  /** First page, as delivered by `redis_get_key`. */
  initial: { elements: any[]; cursor: string; done: boolean };
  /** HLEN/LLEN/SCARD/ZCARD of the whole key, for "200 of 1,048,576". */
  total: number | null | undefined;
  readOnly: boolean;
  onError: (msg: string) => void;
  onBlocked: () => boolean;
}

/**
 * Paged, in-place editor for hash/list/set/zset.
 *
 * Pages come from `redis_get_elements` — the whole key is never read (that is what used to
 * block the Redis server on a large key). A successful edit patches the loaded rows instead
 * of refetching, so editing an element on page 5 does not throw the user back to page 1; the
 * one exception is deleting from a list, where every later index shifts and the loaded pages
 * must be re-read to stay truthful.
 */
export const CollectionTable: React.FC<CollectionTableProps> = ({
  keyName,
  editor,
  initial,
  total,
  readOnly,
  onError,
  onBlocked,
}) => {
  const { t } = useTranslation();
  const [elements, setElements] = useState<any[]>(initial.elements);
  const [cursor, setCursor] = useState(initial.cursor);
  const [done, setDone] = useState(initial.done);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CollRow | null>(null);

  // A new key (or a new type for the same name) resets everything, including the open editor.
  useEffect(() => {
    setElements(initial.elements);
    setCursor(initial.cursor);
    setDone(initial.done);
    setEditingId(null);
    setAdding(false);
    setFilter('');
    setAppliedFilter('');
  }, [initial]);

  const fetchPage = useCallback(async (from: string, replace: boolean, match: string) => {
    setLoading(true);
    const page = await dbHelper.redisGetElements(keyName, editor.kind, from, ELEMENT_PAGE, match || undefined);
    setLoading(false);
    if (!page.success) {
      onError(page.error || t('redis.errReadKey'));
      return;
    }
    setElements((prev) => (replace ? page.elements : prev.concat(page.elements)));
    setCursor(page.nextCursor);
    setDone(page.done);
  }, [keyName, editor.kind, onError, t]);

  /** Re-reads the pages already loaded — used after a list delete shifts the indices. */
  const reloadLoaded = useCallback(async (targetCount: number) => {
    setLoading(true);
    let acc: any[] = [];
    let cur = '';
    let fin = false;
    // Bounded by the number of pages that were loaded, so this cannot walk a huge key.
    while (acc.length < targetCount && !fin) {
      const page = await dbHelper.redisGetElements(keyName, editor.kind, cur, ELEMENT_PAGE, appliedFilter || undefined);
      if (!page.success) {
        onError(page.error || t('redis.errReadKey'));
        break;
      }
      acc = acc.concat(page.elements);
      cur = page.nextCursor;
      fin = page.done;
    }
    setLoading(false);
    setElements(acc);
    setCursor(cur);
    setDone(fin);
  }, [keyName, editor.kind, appliedFilter, onError, t]);

  const applyFilter = () => {
    setAppliedFilter(filter);
    if (editor.serverFilter) {
      // Server-side MATCH: restart the scan so the filter covers the whole key.
      fetchPage('', true, filter);
    }
  };

  const rows: CollRow[] = useMemo(() => {
    const mapped = elements.map((el, i) => editor.toRow(el, i));
    // For list/zset/stream the filter can only apply to what is loaded — see `serverFilter`.
    if (!editor.serverFilter && appliedFilter) {
      const needle = appliedFilter.toLowerCase();
      return mapped.filter((r) => r.cells.some((c) => c.toLowerCase().includes(needle)));
    }
    return mapped;
  }, [elements, editor, appliedFilter]);

  const firstEditable = editor.cols.findIndex((c) => c.editable);

  const startEdit = (row: CollRow) => { setAdding(false); setEditingId(row.id); setDraft([...row.cells]); };
  const startAdd = () => { setEditingId(null); setAdding(true); setDraft(editor.cols.map(() => '')); };
  const cancel = () => { setEditingId(null); setAdding(false); setDraft([]); };

  const commit = async (prev: CollRow | null) => {
    if (busy || onBlocked()) return;
    setBusy(true);
    const ok = await editor.onCommit(draft, prev);
    setBusy(false);
    if (!ok) return;
    // Patch locally rather than refetching, so the scroll position and page survive the edit.
    if (prev) {
      const idx = rows.findIndex((r) => r.id === prev.id);
      if (idx >= 0) {
        setElements((els) => els.map((el, i) => (i === idx ? patchElement(editor.kind, el, draft) : el)));
      }
    } else {
      setElements((els) => els.concat(newElement(editor.kind, draft, els.length)));
    }
    cancel();
  };

  const confirmDelete = async () => {
    const row = pendingDelete;
    setPendingDelete(null);
    if (!row || busy || onBlocked()) return;
    setBusy(true);
    const ok = await editor.onDelete(row);
    setBusy(false);
    if (!ok) return;
    if (editor.indexShiftsOnDelete) {
      await reloadLoaded(elements.length - 1);
    } else {
      const idx = rows.findIndex((r) => r.id === row.id);
      if (idx >= 0) setElements((els) => els.filter((_, i) => i !== idx));
    }
    cancel();
  };

  const draftCells = (prev: CollRow | null) => editor.cols.map((col, i) => (
    <td key={i} style={cellStyle}>
      {col.editable ? (
        <input
          type="text"
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

  const loadedText = total != null && total > elements.length
    ? t('redis.elementsOf', { n: elements.length.toLocaleString(), total: total.toLocaleString() })
    : t('redis.elementCount', { n: rows.length.toLocaleString() });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{loadedText}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', borderRadius: '4px', padding: '0 6px' }}>
          <Search size={11} style={{ color: 'var(--win-text-disabled)' }} />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyFilter(); }}
            onBlur={applyFilter}
            placeholder={editor.serverFilter ? t('redis.filterElements') : t('redis.filterLoadedElements')}
            title={editor.serverFilter ? t('redis.filterElementsTitle') : t('redis.filterLoadedElementsTitle')}
            style={{ width: '150px', background: 'transparent', border: 'none', color: 'var(--win-text-primary)', fontSize: '11px', outline: 'none', padding: '3px 0' }}
          />
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={startAdd} disabled={adding || busy || readOnly} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Plus size={11} /> {t('redis.addElement')}
        </button>
      </div>

      {!editor.serverFilter && appliedFilter && (
        <div style={{ fontSize: '10px', color: '#f59e0b' }}>{t('redis.filterLoadedOnlyNote')}</div>
      )}

      <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'auto', background: 'var(--win-bg-window)' }}>
        <table className="grid-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              {editor.cols.map((c) => <th key={c.label} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}
              <th style={{ width: '58px' }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !adding && (
              <tr><td colSpan={editor.cols.length + 1} style={{ color: 'var(--win-text-disabled)', textAlign: 'center', padding: '10px' }}>{t('redis.emptyCollection')}</td></tr>
            )}
            {rows.map((row) => (
              editingId === row.id ? (
                <tr key={row.id}>
                  {draftCells(row)}
                  {editActions(row)}
                </tr>
              ) : (
                <tr key={row.id} onDoubleClick={() => { if (!row.binary && !readOnly) startEdit(row); }}>
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
                        : !readOnly && iconBtn(t('redis.edit'), Pencil, () => startEdit(row), 'var(--win-accent)')}
                      {!readOnly && !row.binaryKey && iconBtn(t('redis.delete'), Trash2, () => setPendingDelete(row), 'var(--st-danger)')}
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

      {!done && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={() => fetchPage(cursor, false, appliedFilter)} disabled={loading} style={{ padding: '0 10px' }}>
            {loading ? t('redis.loading') : t('redis.loadMoreElements', { n: ELEMENT_PAGE })}
          </button>
          <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.pagedNote')}</span>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('redis.confirmDeleteElementTitle')}
        message={t('redis.confirmDeleteElement')}
        danger
        confirmLabel={t('redis.delete')}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

/** Local mirror of what the write command just stored, so the row shows the new value. */
function patchElement(kind: string, el: any, cells: string[]): any {
  switch (kind) {
    case 'hash': return { ...el, field: cells[0], value: cells[1], binary: false, binaryKey: false };
    case 'list': return { ...el, value: cells[1], binary: false };
    case 'set': return { ...el, value: cells[0], binary: false, binaryKey: false };
    case 'zset': return { ...el, score: Number(cells[0]), member: cells[1], binary: false, binaryKey: false };
    default: return el;
  }
}

function newElement(kind: string, cells: string[], index: number): any {
  switch (kind) {
    case 'hash': return { field: cells[0], value: cells[1] };
    // RPUSH appends, so the new element's index is the current length.
    case 'list': return { index, value: cells[1] };
    case 'set': return { value: cells[0] };
    case 'zset': return { score: Number(cells[0]), member: cells[1] };
    default: return {};
  }
}
