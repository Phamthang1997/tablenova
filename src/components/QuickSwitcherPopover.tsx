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
 * Quick Switcher: đổi **kết nối** hoặc **database** ngay trên thanh tiêu đề.
 *
 * Thay khối popup inline cũ trong `TitleBar.tsx`, khối đó chỉ liệt kê database của server hiện tại —
 * muốn sang một kết nối khác thì phải quay về màn hình Connection Manager. Với N kết nối × N
 * database (§4.3 của `docs/multi-connection-plan.md`) đó là chỗ chậm nhất của luồng dùng hằng ngày.
 *
 * Hai tab thay vì một danh sách gộp: một danh sách phẳng trộn "kết nối" với "database" thì hai thứ
 * có **hệ quả khác nhau** lại trông giống nhau — chọn kết nối là đổi cả workspace, chọn database là
 * mở thêm một kết nối trên cùng server. Tab tách chúng ra mà không cần chú giải.
 *
 * Mọi style ở `index.css` (`.qs-*`), không inline: khối cũ có ~40 object style rải trong JSX nên đổi
 * một khoảng cách phải sửa nhiều chỗ, và không chỗ nào theo được theme.
 */

const DIALECT_ICON: Record<string, React.FC<{ size?: number }>> = {
  sqlite: SqliteIcon,
  postgres: PostgresIcon,
  mysql: MySqlIcon,
  redis: RedisIcon,
};

/**
 * Tên tệp của một đường dẫn SQLite.
 *
 * Đường dẫn đầy đủ (`C:\laragon\data\sqllite\chinook.db`) chiếm cả dòng phụ trong popover 340px và
 * phần đáng đọc — tên tệp — nằm ở cuối, tức là phần bị cắt. Đường dẫn đầy đủ vẫn ở tooltip.
 */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Kết nối đang mở, ghép từ registry backend với phần chỉ frontend biết (nhãn, môi trường). */
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
  /** Vị trí đã tính sẵn từ getBoundingClientRect của nút database. */
  anchor: { top: number; left: number };
  /** Kết nối đang xem — dòng của nó có dấu tích và không bấm được. */
  activeConnId: string;
  /** Database đang xem, để đánh dấu trong tab Databases. */
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
  // Tab Kết nối mở sẵn: đó là việc mới mà popup này tồn tại để làm được, và danh sách database vẫn
  // nằm cách một cú bấm với số lượng hiện ngay trên tab.
  const [tab, setTab] = useState<'conns' | 'dbs'>('conns');
  const [filter, setFilter] = useState('');
  const [dbList, setDbList] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(true);
  /**
   * Latency mỗi kết nối, đo một lần khi popup mở.
   *
   * Không lặp lại theo chu kỳ: đây là hộp thoại sống vài giây, và một `SELECT 1` mỗi vài giây trên
   * *mọi* kết nối là tiếng ồn thường trực gửi tới cả những server mà người dùng không nhìn. Con số
   * này trả lời "kết nối kia còn sống và nhanh chậm thế nào" tại thời điểm mở, đúng lúc cần biết.
   */
  const [pings, setPings] = useState<Map<string, { ok: boolean; latencyMs: number }>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);

  // Đọc một lần khi mở. Profile nằm trong localStorage nên không có gì phải chờ; danh sách database
  // thì là truy vấn thật trên kết nối đang xem.
  const savedProfiles = useMemo(() => loadSavedProfiles(), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await dbHelper.listDatabases(activeConnId);
        if (alive) setDbList(res.databases || []);
      } catch {
        /* server không cho liệt kê -> danh sách rỗng, không phải lỗi chặn */
      } finally {
        if (alive) setDbLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeConnId]);

  // Song song với danh sách database, không xếp sau: hai lời gọi độc lập, và ping của một server ở xa
  // có thể chậm hơn cả `listDatabases` cục bộ.
  useEffect(() => {
    let alive = true;
    dbHelper
      .pingConnections()
      .then((m) => {
        if (alive) setPings(m);
      })
      .catch(() => {
        /* không ping được thì các dòng chỉ không có số, không phải lỗi chặn */
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
   * Profile đã lưu mà **chưa** mở, so theo `scopeKey` — tức server + database, không chỉ server.
   *
   * `connKey` một mình sẽ coi profile trỏ vào `test` là "đã mở" khi đang mở `sakila` trên cùng
   * server, nên bấm vào nó không có gì xảy ra và người dùng không hiểu tại sao.
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
   * Profile chưa mở — **chưa** lọc theo ô tìm kiếm.
   *
   * Tách khỏi danh sách để hiển thị vì con số trên tab phải là "tab này có bao nhiêu thứ", không phải
   * "bao nhiêu thứ khớp với thứ đang gõ". Trước đây tab đếm `openConns + savedProfiles` nguyên bản,
   * tức cộng cả những profile đã mở lần thứ hai: 2 kết nối + 4 profile = tab hiện **6** trong khi
   * danh sách dưới nó hiện 2 + 2.
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
   * Ô logo, dùng lại `cm-badge` của Connection Manager thay vì một icon trơn.
   *
   * Không phải để cho giống: nền theo dialect làm mỗi dòng có một mỏ neo màu, nên quét danh sách là
   * nhận ra engine trước khi đọc chữ — đúng việc mà một danh sách kết nối cần.
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
                    {/* Chưa có số thì KHÔNG chừa chỗ trống: một cột số nhấp nháy hiện ra sau vài trăm
                        ms sẽ làm cả danh sách nhảy. Ping không thành công hiện dấu gạch đỏ — kết nối
                        chết là thông tin, không phải thiếu dữ liệu. */}
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
                      {/* Không cho xoá database đang xem: lệnh sẽ thất bại ở server vì đang có kết
                          nối tới nó, nên đưa nút ra là mời người dùng vào một lỗi chắc chắn. */}
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
