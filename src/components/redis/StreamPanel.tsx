import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Save, Trash2, X, Users, RefreshCw, Check, HandGrab } from 'lucide-react';
import { dbHelper } from '../../utils/dbHelper';
import { ConfirmDialog } from '../ConfirmDialog';
import { ELEMENT_PAGE } from './shared';

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
    <div className="redis-stream">
      <div className="redis-stream-tabs">
        {([['entries', t('redis.streamEntries')], ['groups', t('redis.streamGroups')]] as const).map(([id, label]) => (
          <button
            key={id}
            className={`btn btn-secondary redis-value-btn wide${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'entries' ? (
        <>
          <div className="redis-stream-bar">
            <span className="redis-value-meta">
              {total != null && total > entries.length
                ? t('redis.elementsOf', { n: entries.length.toLocaleString(), total: total.toLocaleString() })
                : t('redis.elementCount', { n: entries.length.toLocaleString() })}
            </span>
            <span className="redis-value-meta">{t('redis.streamImmutable')}</span>
            <div className="redis-keylist-spacer" />
            <button className="btn btn-secondary redis-value-save" onClick={() => setAdding(true)} disabled={adding || busy || readOnly}>
              <Plus size={11} /> {t('redis.streamAddEntry')}
            </button>
          </div>

          {adding && (
            <div className="redis-stream-form">
              <input
                type="text"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder={t('redis.streamIdPlaceholder')}
                spellCheck={false}
                className="redis-inline-input boxed"
              />
              {fields.map((f, i) => (
                <div key={i} className="redis-stream-field-row">
                  <input type="text" value={f.field} onChange={(e) => patch(i, { field: e.target.value })} placeholder="field" spellCheck={false} className="redis-inline-input boxed field" />
                  <input type="text" value={f.value} onChange={(e) => patch(i, { value: e.target.value })} placeholder="value" spellCheck={false} className="redis-inline-input boxed grow" />
                  <button
                    onClick={() => setFields((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))}
                    disabled={fields.length === 1}
                    title={t('redis.delete')}
                    className="redis-cell-btn danger"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <div className="redis-stream-form-actions">
                <button className="btn btn-secondary redis-keylist-mode" onClick={() => setFields((prev) => [...prev, { field: '', value: '' }])}>
                  <Plus size={10} /> {t('redis.streamAddField')}
                </button>
                <div className="redis-keylist-spacer" />
                <button className="btn btn-secondary redis-value-btn wide" onClick={resetForm} disabled={busy}>{t('common.cancel')}</button>
                <button className="btn btn-primary redis-value-save" onClick={submitAdd} disabled={busy}>
                  <Save size={11} /> {t('common.save')}
                </button>
              </div>
            </div>
          )}

          {entries.length === 0 && !adding && (
            <div className="redis-stream-empty">{t('redis.emptyCollection')}</div>
          )}
          {entries.map((e: any, i: number) => (
            <div key={e.id ?? i} className="redis-stream-entry">
              <div className="redis-stream-entry-head">
                <span className="redis-stream-entry-id">{e.id}</span>
                <div className="redis-keylist-spacer" />
                {!readOnly && (
                  <button
                    onClick={() => setPendingDelete(e.id)}
                    disabled={busy}
                    title={t('redis.delete')}
                    className="redis-cell-btn danger"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <div className="redis-table-wrap flat">
                <table className="grid-table redis-table">
                  <thead><tr><th>Field</th><th>Value</th></tr></thead>
                  <tbody>
                    {(e.fields || []).map((f: any, j: number) => (
                      <tr key={j}>
                        <td className="redis-cell">{f.field}</td>
                        <td className="redis-cell">{typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {!done && (
            <button className="btn btn-secondary redis-value-btn wide start" onClick={loadMore} disabled={loading}>
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
    <div className="redis-stream groups">
      <div className="redis-value-bar">
        <Users size={12} className="redis-keylist-db-icon" />
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          className="redis-keylist-select wide"
        >
          <option value="">{t('redis.pickGroup')}</option>
          {groups.map((g: any) => <option key={String(g.name)} value={String(g.name)}>{String(g.name)}</option>)}
        </select>
        <button className="btn btn-secondary redis-keylist-mode" onClick={loadGroups} disabled={loading}>
          <RefreshCw size={11} /> {t('redis.refresh')}
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="redis-stream-empty">{t('redis.noGroups')}</div>
      ) : (
        <div className="redis-table-wrap">
          <table className="grid-table redis-table">
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
                  <td className="redis-cell">{String(g.name)}</td>
                  <td className="redis-cell">{String(g.consumers ?? '-')}</td>
                  <td className="redis-cell">{String(g.pending ?? '-')}</td>
                  <td className="redis-cell">{String(g['last-delivered-id'] ?? '-')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {group && (
        <>
          <div className="redis-stream-subtitle">{t('redis.consumersOf', { group })}</div>
          <div className="redis-table-wrap">
            <table className="grid-table redis-table">
              <thead>
                <tr>
                  <th>{t('redis.colConsumer')}</th>
                  <th>{t('redis.colPending')}</th>
                  <th>{t('redis.colIdle')}</th>
                </tr>
              </thead>
              <tbody>
                {consumers.length === 0 && (
                  <tr><td colSpan={3} className="redis-table-empty">{t('redis.noConsumers')}</td></tr>
                )}
                {consumers.map((c: any) => (
                  <tr key={String(c.name)}>
                    <td className="redis-cell">{String(c.name)}</td>
                    <td className="redis-cell">{String(c.pending ?? '-')}</td>
                    <td className="redis-cell">{String(c.idle ?? '-')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="redis-value-bar">
            <span className="redis-stream-subtitle">{t('redis.pendingEntries')}</span>
            {!readOnly && (
              <>
                <span className="redis-value-meta">{t('redis.claimAs')}</span>
                <input
                  type="text"
                  value={claimAs}
                  onChange={(e) => setClaimAs(e.target.value)}
                  placeholder="consumer"
                  spellCheck={false}
                  className="redis-inline-input boxed fixed"
                />
              </>
            )}
          </div>
          <div className="redis-table-wrap">
            <table className="grid-table redis-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t('redis.colConsumer')}</th>
                  <th>{t('redis.colIdle')}</th>
                  <th>{t('redis.colDeliveries')}</th>
                  {!readOnly && <th className="redis-actions-col wide" />}
                </tr>
              </thead>
              <tbody>
                {pending.length === 0 && (
                  <tr><td colSpan={readOnly ? 4 : 5} className="redis-table-empty">{t('redis.noPending')}</td></tr>
                )}
                {pending.map((p: any) => (
                  <tr key={p.id}>
                    <td className="redis-cell">{p.id}</td>
                    <td className="redis-cell">{p.consumer}</td>
                    <td className="redis-cell">{p.idleMs} ms</td>
                    <td className="redis-cell">{p.deliveryCount}</td>
                    {!readOnly && (
                      <td className="redis-cell">
                        <div className="redis-cell-actions">
                          <button onClick={() => ack(p.id)} title="XACK" className="redis-cell-btn ok">
                            <Check size={12} />
                          </button>
                          <button onClick={() => claim(p.id)} title="XCLAIM" className="redis-cell-btn accent">
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
          <div className="redis-pill static">{t('redis.pendingNote')}</div>
        </>
      )}
    </div>
  );
};
