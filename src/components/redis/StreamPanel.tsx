import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Save, Trash2, X, Users, RefreshCw, Check, HandGrab } from 'lucide-react';
import { dbHelper } from '../../utils/dbHelper';
import { ConfirmDialog } from '../ConfirmDialog';
import { ELEMENT_PAGE, cellStyle, inlineInput, pillStyle } from './shared';

interface StreamPanelProps {
  keyName: string;
  initial: { elements: any[]; cursor: string; done: boolean };
  total: number | null | undefined;
  readOnly: boolean;
  onError: (msg: string) => void;
  onOk: (msg: string) => void;
  onBlocked: () => boolean;
}

type Tab = 'entries' | 'groups';

/**
 * Stream viewer: paged entries plus consumer groups.
 *
 * Entries are immutable in Redis — there is no "edit entry", only XADD/XDEL — so the table is
 * read-only per row with add/delete around it. The groups tab is the part that makes a stream
 * debuggable: which consumer holds what, how long it has been idle, ACK or claim it.
 */
export const StreamPanel: React.FC<StreamPanelProps> = ({
  keyName, initial, total, readOnly, onError, onOk, onBlocked,
}) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('entries');

  const [entries, setEntries] = useState<any[]>(initial.elements);
  const [cursor, setCursor] = useState(initial.cursor);
  const [done, setDone] = useState(initial.done);
  const [loading, setLoading] = useState(false);

  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState('');
  const [fields, setFields] = useState<{ field: string; value: string }[]>([{ field: '', value: '' }]);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    setEntries(initial.elements);
    setCursor(initial.cursor);
    setDone(initial.done);
    setAdding(false);
  }, [initial]);

  const loadMore = async () => {
    setLoading(true);
    const page = await dbHelper.redisGetElements(keyName, 'stream', cursor, ELEMENT_PAGE);
    setLoading(false);
    if (!page.success) { onError(page.error || t('redis.errReadKey')); return; }
    setEntries((prev) => prev.concat(page.elements));
    setCursor(page.nextCursor);
    setDone(page.done);
  };

  const resetForm = () => { setAdding(false); setNewId(''); setFields([{ field: '', value: '' }]); };

  const submitAdd = async () => {
    if (busy || onBlocked()) return;
    const clean = fields.filter((f) => f.field.trim() !== '');
    if (clean.length === 0) { onError(t('redis.errStreamNoField')); return; }
    setBusy(true);
    const res = await dbHelper.redisStreamAdd(keyName, newId, clean);
    setBusy(false);
    if (!res.success) { onError(res.error || t('redis.errSave')); return; }
    onOk(t('redis.savedElement'));
    resetForm();
    // A new entry lands at the end of the stream, which is not the page being shown; re-read
    // the first page so the view is not silently stale.
    const page = await dbHelper.redisGetElements(keyName, 'stream', '', ELEMENT_PAGE);
    if (page.success) { setEntries(page.elements); setCursor(page.nextCursor); setDone(page.done); }
  };

  const confirmDelete = async () => {
    const id = pendingDelete;
    setPendingDelete(null);
    if (!id || busy || onBlocked()) return;
    setBusy(true);
    const res = await dbHelper.redisStreamDel(keyName, id);
    setBusy(false);
    if (!res.success) { onError(res.error || t('redis.errSave')); return; }
    onOk(t('redis.deletedElement'));
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const patch = (i: number, part: Partial<{ field: string; value: string }>) =>
    setFields((prev) => prev.map((f, j) => (j === i ? { ...f, ...part } : f)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: '6px' }}>
        {([['entries', t('redis.streamEntries')], ['groups', t('redis.streamGroups')]] as const).map(([id, label]) => (
          <button
            key={id}
            className="btn btn-secondary"
            onClick={() => setTab(id)}
            style={{
              padding: '0 10px',
              borderColor: tab === id ? 'var(--win-accent)' : undefined,
              color: tab === id ? 'var(--win-accent)' : undefined,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'entries' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>
              {total != null && total > entries.length
                ? t('redis.elementsOf', { n: entries.length.toLocaleString(), total: total.toLocaleString() })
                : t('redis.elementCount', { n: entries.length.toLocaleString() })}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.streamImmutable')}</span>
            <div style={{ flex: 1 }} />
            <button className="btn btn-secondary" onClick={() => setAdding(true)} disabled={adding || busy || readOnly} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Plus size={11} /> {t('redis.streamAddEntry')}
            </button>
          </div>

          {adding && (
            <div style={{ border: '1px solid var(--win-accent)', borderRadius: '4px', padding: '8px', background: 'var(--win-bg-window)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <input
                type="text"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder={t('redis.streamIdPlaceholder')}
                spellCheck={false}
                style={{ ...inlineInput, border: '1px solid var(--win-border)', borderRadius: '3px', padding: '4px 6px' }}
              />
              {fields.map((f, i) => (
                <div key={i} style={{ display: 'flex', gap: '4px' }}>
                  <input type="text" value={f.field} onChange={(e) => patch(i, { field: e.target.value })} placeholder="field" spellCheck={false} style={{ ...inlineInput, flex: '0 0 32%', border: '1px solid var(--win-border)', borderRadius: '3px', padding: '4px 6px' }} />
                  <input type="text" value={f.value} onChange={(e) => patch(i, { value: e.target.value })} placeholder="value" spellCheck={false} style={{ ...inlineInput, flex: 1, border: '1px solid var(--win-border)', borderRadius: '3px', padding: '4px 6px' }} />
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
                <button className="btn btn-secondary" onClick={resetForm} disabled={busy} style={{ padding: '0 10px' }}>{t('common.cancel')}</button>
                <button className="btn btn-primary" onClick={submitAdd} disabled={busy} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Save size={11} /> {t('common.save')}
                </button>
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
                {!readOnly && (
                  <button
                    onClick={() => setPendingDelete(e.id)}
                    disabled={busy}
                    title={t('redis.delete')}
                    style={{ background: 'transparent', border: 'none', color: 'var(--st-danger)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, padding: '2px', display: 'flex' }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'auto' }}>
                <table className="grid-table" style={{ width: '100%' }}>
                  <thead><tr><th>Field</th><th>Value</th></tr></thead>
                  <tbody>
                    {(e.fields || []).map((f: any, j: number) => (
                      <tr key={j}>
                        <td style={cellStyle}>{f.field}</td>
                        <td style={cellStyle}>{typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {!done && (
            <button className="btn btn-secondary" onClick={loadMore} disabled={loading} style={{ padding: '0 10px', alignSelf: 'flex-start' }}>
              {loading ? t('redis.loading') : t('redis.loadMoreElements', { n: ELEMENT_PAGE })}
            </button>
          )}
        </>
      ) : (
        <ConsumerGroups keyName={keyName} readOnly={readOnly} onError={onError} onOk={onOk} onBlocked={onBlocked} />
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

interface GroupsProps {
  keyName: string;
  readOnly: boolean;
  onError: (msg: string) => void;
  onOk: (msg: string) => void;
  onBlocked: () => boolean;
}

/** XINFO GROUPS / CONSUMERS + XPENDING, with XACK and XCLAIM on the pending entries. */
const ConsumerGroups: React.FC<GroupsProps> = ({ keyName, readOnly, onError, onOk, onBlocked }) => {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<any[]>([]);
  const [group, setGroup] = useState<string>('');
  const [consumers, setConsumers] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [claimAs, setClaimAs] = useState('');
  const [loading, setLoading] = useState(false);

  const loadGroups = useCallback(async () => {
    setLoading(true);
    const res = await dbHelper.redisStreamGroups(keyName);
    setLoading(false);
    if (!res.success) { onError(res.error || t('redis.errStreamGroups')); return; }
    setGroups(res.groups);
    // XINFO uses hyphenated field names; they are protocol keys, not UI text.
    const first = res.groups[0]?.name;
    if (first && !group) setGroup(String(first));
  }, [keyName, group, onError, t]);

  const loadGroupDetail = useCallback(async (g: string) => {
    if (!g) return;
    const [c, p] = await Promise.all([
      dbHelper.redisStreamConsumers(keyName, g),
      dbHelper.redisStreamPending(keyName, g),
    ]);
    if (c.success) setConsumers(c.consumers); else onError(c.error || t('redis.errStreamGroups'));
    if (p.success) setPending(p.pending); else onError(p.error || t('redis.errStreamGroups'));
  }, [keyName, onError, t]);

  useEffect(() => { loadGroups(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [keyName]);
  useEffect(() => { loadGroupDetail(group); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [group]);

  const ack = async (id: string) => {
    if (onBlocked()) return;
    const res = await dbHelper.redisStreamAck(keyName, group, [id]);
    if (!res.success) { onError(res.error || t('redis.errSave')); return; }
    onOk(t('redis.streamAcked'));
    setPending((prev) => prev.filter((p) => p.id !== id));
  };

  const claim = async (id: string) => {
    if (onBlocked()) return;
    const consumer = claimAs.trim();
    if (!consumer) { onError(t('redis.errClaimConsumer')); return; }
    const res = await dbHelper.redisStreamClaim(keyName, group, consumer, 0, [id]);
    if (!res.success) { onError(res.error || t('redis.errSave')); return; }
    onOk(t('redis.streamClaimed'));
    loadGroupDetail(group);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <Users size={12} style={{ color: 'var(--win-accent)' }} />
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '11px', padding: '3px 6px' }}
        >
          <option value="">{t('redis.pickGroup')}</option>
          {groups.map((g: any) => <option key={String(g.name)} value={String(g.name)}>{String(g.name)}</option>)}
        </select>
        <button className="btn btn-secondary" onClick={loadGroups} disabled={loading} style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <RefreshCw size={11} /> {t('redis.refresh')}
        </button>
      </div>

      {groups.length === 0 ? (
        <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>{t('redis.noGroups')}</div>
      ) : (
        <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'auto', background: 'var(--win-bg-window)' }}>
          <table className="grid-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{t('redis.colGroup')}</th>
                <th>{t('redis.colConsumers')}</th>
                <th>{t('redis.colPending')}</th>
                <th>{t('redis.colLastDelivered')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g: any) => (
                <tr key={String(g.name)}>
                  <td style={cellStyle}>{String(g.name)}</td>
                  <td style={cellStyle}>{String(g.consumers ?? '-')}</td>
                  <td style={cellStyle}>{String(g.pending ?? '-')}</td>
                  <td style={cellStyle}>{String(g['last-delivered-id'] ?? '-')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {group && (
        <>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)' }}>{t('redis.consumersOf', { group })}</div>
          <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'auto', background: 'var(--win-bg-window)' }}>
            <table className="grid-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>{t('redis.colConsumer')}</th>
                  <th>{t('redis.colPending')}</th>
                  <th>{t('redis.colIdle')}</th>
                </tr>
              </thead>
              <tbody>
                {consumers.length === 0 && (
                  <tr><td colSpan={3} style={{ textAlign: 'center', padding: '8px', color: 'var(--win-text-disabled)' }}>{t('redis.noConsumers')}</td></tr>
                )}
                {consumers.map((c: any) => (
                  <tr key={String(c.name)}>
                    <td style={cellStyle}>{String(c.name)}</td>
                    <td style={cellStyle}>{String(c.pending ?? '-')}</td>
                    <td style={cellStyle}>{String(c.idle ?? '-')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)' }}>{t('redis.pendingEntries')}</span>
            {!readOnly && (
              <>
                <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.claimAs')}</span>
                <input
                  type="text"
                  value={claimAs}
                  onChange={(e) => setClaimAs(e.target.value)}
                  placeholder="consumer"
                  spellCheck={false}
                  style={{ ...inlineInput, width: '140px', border: '1px solid var(--win-border)', padding: '3px 6px' }}
                />
              </>
            )}
          </div>
          <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'auto', background: 'var(--win-bg-window)' }}>
            <table className="grid-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t('redis.colConsumer')}</th>
                  <th>{t('redis.colIdle')}</th>
                  <th>{t('redis.colDeliveries')}</th>
                  {!readOnly && <th style={{ width: '80px' }} />}
                </tr>
              </thead>
              <tbody>
                {pending.length === 0 && (
                  <tr><td colSpan={readOnly ? 4 : 5} style={{ textAlign: 'center', padding: '8px', color: 'var(--win-text-disabled)' }}>{t('redis.noPending')}</td></tr>
                )}
                {pending.map((p: any) => (
                  <tr key={p.id}>
                    <td style={cellStyle}>{p.id}</td>
                    <td style={cellStyle}>{p.consumer}</td>
                    <td style={cellStyle}>{p.idleMs} ms</td>
                    <td style={cellStyle}>{p.deliveryCount}</td>
                    {!readOnly && (
                      <td style={cellStyle}>
                        <div style={{ display: 'flex', gap: '2px' }}>
                          <button onClick={() => ack(p.id)} title="XACK" style={{ background: 'transparent', border: 'none', color: 'var(--st-ok, #10b981)', cursor: 'pointer', padding: '2px', display: 'flex' }}>
                            <Check size={12} />
                          </button>
                          <button onClick={() => claim(p.id)} title="XCLAIM" style={{ background: 'transparent', border: 'none', color: 'var(--win-accent)', cursor: 'pointer', padding: '2px', display: 'flex' }}>
                            <HandGrab size={12} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ ...pillStyle, cursor: 'default', alignSelf: 'flex-start' }}>{t('redis.pendingNote')}</div>
        </>
      )}
    </div>
  );
};
