import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BarChart3, Check, Database, Lock, Plus, Search, Trash2, X } from 'lucide-react';
import { PostgresIcon, MySqlIcon, RedisIcon, SqliteIcon } from './DbIcons';
import { dbHelper } from '../utils/dbHelper';
import type { DbConnectionConfig } from '../utils/dbHelper';
import { loadSavedProfiles } from '../utils/connectProfile';
import type { SavedProfile } from './ConnectionManager';
import { scopeKey } from '../utils/connKey';
import { envLabelKey, normalizeEnv, type ConnEnv } from '../utils/connEnv';

/**
 * Quick Switcher: đổi **kết nối** or **database** ngay on title bar.
 *
 * Thay khối popup inline cũ in `TitleBar.tsx`, khối đó chỉ liệt kê database of server hiện tại —
 * muốn sang một kết nối khác thì must quay về màn hình Connection Manager. with N kết nối × N
 * database (§4.3 of `docs/multi-connection-plan.md`) đó is chỗ chậm nhất of luồng dùng hằng ngày.
 *
 * Hai tab thay vì một danh sách gộp: một danh sách phẳng trộn "kết nối" with "database" thì hai thứ
 * có **hệ quả khác nhau** lại trông giống nhau — select kết nối is đổi cả workspace, select database is
 * open add một kết nối on cùng server. Tab tách chúng ra mà not cần chú giải.
 *
 * Mọi style at `index.css` (`.qs-*`), not inline: khối cũ có ~40 object style rải in JSX nên đổi
 * một spacing must edit nhiều chỗ, and not chỗ nào theo is theme.
 */

const DIALECT_ICON: Record<string, React.FC<{ size?: number }>> = {
  sqlite: SqliteIcon,
  postgres: PostgresIcon,
  mysql: MySqlIcon,
  redis: RedisIcon,
};

/**
 * Tên tệp of một đường dẫn SQLite.
 *
 * Đường dẫn đầy đủ (`C:\laragon\data\sqllite\chinook.db`) chiếm cả row phụ in popover 340px and
 * phần đáng read — tên tệp — nằm at cuối, tức is phần is cắt. Đường dẫn đầy đủ vẫn at tooltip.
 */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Kết nối currently open, ghép from registry backend with phần chỉ frontend biết (nhãn, environment). */
export interface SwitcherConn {
  connId: string;
  db: string;
  dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis';
  profileName: string;
  color: string;
  env: ConnEnv;
  readOnly?: boolean;
  config: DbConnectionConfig | null;
}

interface QuickSwitcherPopoverProps {
  /** position already tính sẵn from getBoundingClientRect of nút database. */
  anchor: { top: number; left: number };
  /** Kết nối currently xem — row of nó có dấu tích and not bấm is. */
  activeConnId: string;
  /** Database currently xem, to đánh dấu in tab Databases. */
  activeDbName?: string;
  openConns: SwitcherConn[];
  onSelectConnection: (connId: string) => void;
  onConnectSavedProfile: (profile: SavedProfile) => void;
  onOpenDatabase: (name: string) => void;
  onCreateDatabase: () => void;
  onDropDatabase: (name: string) => void;
  onNewConnection: () => void;
  onOpenAllDbStats: () => void;
  onClose: () => void;
}

export const QuickSwitcherPopover: React.FC<QuickSwitcherPopoverProps> = ({
  anchor,
  activeConnId,
  activeDbName,
  openConns,
  onSelectConnection,
  onConnectSavedProfile,
  onOpenDatabase,
  onCreateDatabase,
  onDropDatabase,
  onNewConnection,
  onOpenAllDbStats,
  onClose,
}) => {
  const { t } = useTranslation();
  // Tab Kết nối open sẵn: đó is việc mới mà popup này tồn tại to ism is, and danh sách database vẫn
  // nằm cách một cú bấm with số lượng hiện ngay on tab.
  const [tab, setTab] = useState<'conns' | 'dbs'>('conns');
  const [filter, setFilter] = useState('');
  const [dbList, setDbList] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(true);
  /**
   * Latency mỗi kết nối, đo một lần when popup open.
   *
   * not lặp lại theo chu kỳ: đây is hộp thoại sống andi giây, and một `SELECT 1` mỗi andi giây on
   * *mọi* kết nối is tiếng ồn thường trực send tới cả những server mà user not nhìn. Con số
   * này trả lời "kết nối kia còn sống and nhanh chậm thế nào" tại thời điểm open, đúng lúc cần biết.
   */
  const [pings, setPings] = useState<Map<string, { ok: boolean; latencyMs: number }>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);

  // read một lần when open. Profile nằm in localStorage nên not có gì must wait; danh sách database
  // thì is query thật on kết nối currently xem.
  const savedProfiles = useMemo(() => loadSavedProfiles(), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await dbHelper.listDatabases(activeConnId);
        if (alive) setDbList(res.databases || []);
      } catch {
        /* server not for liệt kê -> danh sách rỗng, not must error chặn */
      } finally {
        if (alive) setDbLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeConnId]);

  // Song song with danh sách database, not xếp sau: hai lời gọi độc lập, and ping of một server at xa
  // can chậm hơn cả `listDatabases` cục bộ.
  useEffect(() => {
    let alive = true;
    dbHelper
      .pingConnections()
      .then((m) => {
        if (alive) setPings(m);
      })
      .catch(() => {
        /* not ping is thì các row chỉ not có số, not must error chặn */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = filter.toLowerCase().trim();

  /**
   * Profile already save mà **chưa** open, so theo `scopeKey` — tức server + database, not chỉ server.
   *
   * `connKey` một mình will coi profile trỏ ando `test` is "already open" when currently open `sakila` on cùng
   * server, nên bấm ando nó not có gì xảy ra and user not hiểu tại sao.
   */
  const openScopes = useMemo(
    () => new Set(openConns.map((c) => scopeKey(c.config, c.config?.database ?? c.db))),
    [openConns],
  );

  const conns = openConns.filter((c) => {
    if (!q) return true;
    return (
      c.db.toLowerCase().includes(q) ||
      c.profileName.toLowerCase().includes(q) ||
      (c.config?.host || '').toLowerCase().includes(q)
    );
  });

  /**
   * Profile chưa open — **chưa** filter theo ô search.
   *
   * Tách khỏi danh sách to display vì con số on tab must is "tab này có bao nhiêu thứ", not must
   * "bao nhiêu thứ khớp with thứ currently gõ". Trước đây tab đếm `openConns + savedProfiles` nguyên bản,
   * tức cộng cả những profile already open lần thứ hai: 2 kết nối + 4 profile = tab hiện **6** in when
   * danh sách under nó hiện 2 + 2.
   */
  const unopened = savedProfiles.filter(
    (p) => !openScopes.has(scopeKey(p.config as DbConnectionConfig, p.config?.database)),
  );

  const profiles = unopened.filter((p) => {
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      (p.config?.host || '').toLowerCase().includes(q) ||
      (p.group || '').toLowerCase().includes(q)
    );
  });

  const dbs = dbList.filter((d) => d.toLowerCase().includes(q));

  /**
   * Ô logo, dùng lại `cm-badge` of Connection Manager thay vì một icon trơn.
   *
   * not must to for giống: nền theo dialect ism mỗi row có một mỏ neo màu, nên quét danh sách is
   * receive ra engine trước when read chữ — đúng việc mà một danh sách kết nối cần.
   */
  const renderBadge = (dialect: string) => {
    const Icon = DIALECT_ICON[dialect];
    return (
      <span className={`cm-badge sm ${dialect}`}>
        {Icon ? <Icon size={13} /> : <Database size={13} />}
      </span>
    );
  };

  return createPortal(
    <>
      <div className="qs-backdrop" onClick={onClose} />
      <div className="qs-pop" style={{ top: anchor.top, left: anchor.left }} role="dialog">
        {/* Header Segmented Tabs */}
        <div className="qs-header">
          <div className="qs-seg" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'conns'}
              className={`qs-seg-btn${tab === 'conns' ? ' is-on' : ''}`}
              onClick={() => setTab('conns')}
            >
              <span>{t('quickSwitcher.tabConnections')}</span>
              <span className="qs-tab-count">{openConns.length + unopened.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'dbs'}
              className={`qs-seg-btn${tab === 'dbs' ? ' is-on' : ''}`}
              onClick={() => setTab('dbs')}
            >
              <span>{t('quickSwitcher.tabDatabases')}</span>
              <span className="qs-tab-count">{dbLoading ? '…' : dbList.length}</span>
            </button>
          </div>
        </div>

        {/* Integrated Search Box */}
        <div className="qs-search">
          <div className="qs-search-box">
            <Search size={13} className="qs-search-icon" />
            <input
              ref={searchRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={
                tab === 'conns' ? t('quickSwitcher.searchConnections') : t('quickSwitcher.searchDatabases')
              }
            />
            {filter && (
              <button
                type="button"
                className="qs-search-clear"
                onClick={() => {
                  setFilter('');
                  searchRef.current?.focus();
                }}
                title={t('common.clear')}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="qs-list">
          {tab === 'conns' ? (
            <>
              <div className="qs-group">{t('quickSwitcher.groupOpen', { n: conns.length })}</div>
              {conns.length === 0 && <div className="qs-empty">{t('quickSwitcher.noMatch')}</div>}
              {conns.map((c) => {
                const isActive = c.connId === activeConnId;
                const env = normalizeEnv(c.env);
                const sub = c.dbType === 'sqlite' ? fileName(c.db) : c.db;
                const ping = pings.get(c.connId);
                return (
                  <button
                    type="button"
                    key={c.connId}
                    className={`qs-row${isActive ? ' is-on' : ''}`}
                    onClick={() => {
                      if (!isActive) onSelectConnection(c.connId);
                      onClose();
                    }}
                    title={[
                      c.profileName,
                      c.db,
                      c.config?.host,
                      env !== 'none' ? t(envLabelKey(env)) : '',
                      ping && !ping.ok ? t('quickSwitcher.pingFailed') : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    {renderBadge(c.dbType)}
                    <span className="qs-label">
                      <span className="qs-name">{c.profileName}</span>
                      <span className="qs-sub">{sub}</span>
                    </span>
                    {/* Chưa có số thì not chừa chỗ trống: một column số nhấp nháy hiện ra sau andi trăm
                        ms will ism cả danh sách nhảy. Ping not successful hiện dấu gạch đỏ — kết nối
                        chết is thông tin, not must thiếu dữ liệu. */}
                    {ping && (
                      <span className={`qs-ping${ping.ok ? '' : ' is-dead'}`}>
                        {ping.ok ? t('quickSwitcher.ms', { n: ping.latencyMs }) : '—'}
                      </span>
                    )}
                    {env !== 'none' && (
                      <span className={`qs-env-chip qs-env-${env}`}>{t(envLabelKey(env))}</span>
                    )}
                    {c.readOnly && (
                      <span className="qs-ro" title={t('app.readOnlyOn')}>
                        <Lock size={11} strokeWidth={2.4} />
                      </span>
                    )}
                    {isActive && <Check size={14} className="qs-check-on" />}
                  </button>
                );
              })}

              <div className="qs-group">{t('quickSwitcher.groupSaved', { n: profiles.length })}</div>
              {profiles.length === 0 && (
                <div className="qs-empty">{t('quickSwitcher.allProfilesOpen')}</div>
              )}
              {profiles.map((p) => {
                const env = normalizeEnv(p.env);
                const raw =
                  p.config?.database || p.config?.sqlitePath || p.config?.host || p.type;
                return (
                  <button
                    type="button"
                    key={p.id}
                    className="qs-row"
                    onClick={() => {
                      onConnectSavedProfile(p);
                      onClose();
                    }}
                    title={[p.name, raw, p.config?.host, env !== 'none' ? t(envLabelKey(env)) : '']
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    {renderBadge(p.type)}
                    <span className="qs-label">
                      <span className="qs-name">{p.name}</span>
                      <span className="qs-sub">{p.type === 'sqlite' ? fileName(raw) : raw}</span>
                    </span>
                    {env !== 'none' ? (
                      <span className={`qs-env-chip qs-env-${env}`}>{t(envLabelKey(env))}</span>
                    ) : (
                      p.group && <span className="qs-group-chip">{p.group}</span>
                    )}
                  </button>
                );
              })}
            </>
          ) : (
            <>
              {dbLoading ? (
                <div className="qs-empty">{t('quickSwitcher.loadingDatabases')}</div>
              ) : dbs.length === 0 ? (
                <div className="qs-empty">{t('quickSwitcher.noDatabases')}</div>
              ) : (
                dbs.map((db) => {
                  const isActive = db === activeDbName;
                  return (
                    <div key={db} className={`qs-row qs-row-db${isActive ? ' is-on' : ''}`}>
                      <button
                        type="button"
                        className="qs-row-main"
                        onClick={() => {
                          if (!isActive) onOpenDatabase(db);
                          onClose();
                        }}
                      >
                        <span className="qs-db-dot" aria-hidden />
                        <span className="qs-label">
                          <span className="qs-name">{db}</span>
                        </span>
                        {isActive && <Check size={14} className="qs-check-on" />}
                      </button>
                      {/* not for delete database currently xem: lệnh will failed at server vì currently có kết
                          nối tới nó, nên đưa nút ra is mời user ando một error chắc chắn. */}
                      {!isActive && (
                        <button
                          type="button"
                          className="qs-drop"
                          title={t('quickSwitcher.dropDatabase', { name: db })}
                          onClick={() => {
                            onDropDatabase(db);
                            onClose();
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>

        <div className="qs-footer">
          {tab === 'conns' ? (
            <button
              type="button"
              className="qs-foot-btn accent"
              onClick={() => {
                onClose();
                onNewConnection();
              }}
            >
              <Plus size={13} />
              <span>{t('quickSwitcher.newConnection')}</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                className="qs-foot-btn accent"
                onClick={() => {
                  onClose();
                  onCreateDatabase();
                }}
              >
                <Plus size={13} />
                <span>{t('quickSwitcher.createDatabase')}</span>
              </button>
              <button
                type="button"
                className="qs-foot-btn"
                onClick={() => {
                  onClose();
                  onOpenAllDbStats();
                }}
              >
                <BarChart3 size={13} />
                <span>{t('quickSwitcher.allDbStats')}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
};
