import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Database, Lock } from 'lucide-react';
import { PostgresIcon, MySqlIcon, SqliteIcon } from './DbIcons';
import { dbHelper, type OpenConnection } from '../utils/dbHelper';
import { envLabelKey, type ConnEnv } from '../utils/connEnv';

/**
 * Brand mark per dialect, the same ones the Connection Manager uses.
 *
 * A generic cylinder for all three made two connections to *different engines* look identical, and
 * the engine is often the fastest way to tell them apart when the database names are similar
 * (`sakila` on MySQL vs a Postgres restore of it).
 */
const DIALECT: Record<string, { label: string; Icon: React.FC<{ size?: number }> }> = {
  sqlite: { label: 'SQLite', Icon: SqliteIcon },
  postgres: { label: 'PostgreSQL', Icon: PostgresIcon },
  mysql: { label: 'MySQL', Icon: MySqlIcon },
};

interface DbRailProps {
  /** Connection whose workspace is on screen — its cell is highlighted. */
  activeConnId: string;
  /** Point the app at another open connection. */
  onSelect: (conn: OpenConnection) => void;
  /** Close one connection. */
  onClose: (connId: string) => void;
  /** Close every connection except this one. */
  onCloseOthers: (connId: string) => void;
  /** Flip the read-only flag of one connection. */
  onToggleReadOnly: (connId: string) => void;
  /** Môi trường của một kết nối. Trường riêng của profile, KHÔNG suy từ màu — xem `utils/connEnv.ts`. */
  envOf: (connId: string) => ConnEnv;
  /** Nhãn màu của kết nối (chọn từ connection info popover). */
  colorOf?: (connId: string) => string;
  /** Bumped by the caller when a connect/disconnect happened, to refetch. */
  reloadKey?: number;
}

/**
 * The narrow column left of the sidebar: **the connections that are open**, one click to switch.
 *
 * It used to list every database on the server and switch the connection onto one. That was the right shape
 * while the backend held one connection, and the wrong one now: with `conn_id` identifying a
 * `(server, database)` pair (§4.3), "every database on the server" would mix databases of server A
 * with databases of server B in one flat column and give the user no way to tell them apart. Listing
 * what is *open* makes the rail exactly the set of live `conn_id`s — which is also the only set a
 * per-connection transaction badge can belong to (§4.2b/§4.2c).
 *
 * A side effect worth having: `list_databases` ran a real query on the active connection every time
 * this mounted. Reading the registry costs nothing.
 */
export const DbRail: React.FC<DbRailProps> = ({
  activeConnId,
  onSelect,
  onClose,
  onCloseOthers,
  onToggleReadOnly,
  envOf,
  colorOf,
  reloadKey = 0,
}) => {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<OpenConnection[]>([]);
  const [menu, setMenu] = useState<{ connId: string; top: number; left: number } | null>(null);

  const reload = useCallback(async () => {
    try {
      setConnections(await dbHelper.listConnections());
    } catch {
      /* not connected yet -> nothing to draw */
    }
  }, []);

  // `database-restored` is the existing event Sidebar and DataGrid already listen to; a restore can
  // rename or drop the database a connection points at, which is what this column displays.
  useEffect(() => {
    void reload();
    const onRestored = () => void reload();
    window.addEventListener('database-restored', onRestored);
    return () => window.removeEventListener('database-restored', onRestored);
  }, [reload, reloadKey, activeConnId]);

  // Hidden with one connection ONLY when that connection carries no warning.
  //
  // "Below two there is nothing to switch between" was the right rule while the rail was just a
  // switcher. It stopped being right once the cell started carrying state the user must see: a
  // single production connection would hide the very red edge and padlock that say so, and a single
  // connection holding uncommitted work would hide its badge. Switching is not the only job any
  // more, so it cannot be the only reason to appear.
  const worthShowing =
    connections.length > 1 ||
    connections.some((c) => c.readOnly || c.pending > 0 || envOf(c.connId) !== 'none');
  if (!worthShowing) return null;

  const closeMenu = () => setMenu(null);
  const menuConn = menu ? connections.find((c) => c.connId === menu.connId) : null;

  return (
    <>
      <div className="db-rail" role="listbox" aria-label={t('sidebar.databases')}>
        {connections.map((c, i) => {
          const isActive = c.connId === activeConnId;
          const meta = DIALECT[c.dialect];
          const Icon = meta?.Icon;
          // A hairline where the server changes. Two databases of one server are one group, and
          // without this the column is a flat list where `(server A, sakila)` and
          // `(server B, sakila)` look like the same thing — the exact confusion §4.3 is about.
          const newServer = i > 0 && connections[i - 1].serverId !== c.serverId;
          // Environment is its own field on the profile — see utils/connEnv.ts. Drawn as a tint on
          // the cell rather than a word, because the rail is 64px and the thing that has to register
          // in half a second is "this one is production", not which word it is.
          const env = envOf(c.connId);
          const color = (colorOf ? colorOf(c.connId) : '').toLowerCase();
          let colorClass = '';
          if (color === '#fca5a5') colorClass = ' db-rail-color-red';
          else if (color === '#86efac') colorClass = ' db-rail-color-green';
          else if (color === '#a5b4fc') colorClass = ' db-rail-color-blue';
          else if (color === '#fde68a') colorClass = ' db-rail-color-yellow';

          return (
            <button
              key={c.connId}
              type="button"
              role="option"
              aria-selected={isActive}
              className={`db-rail-item${isActive ? ' is-on' : ''}${newServer ? ' db-rail-sep' : ''}${colorClass}`}
              title={[
                c.db,
                meta?.label ?? c.dialect,
                env !== 'none' ? t(envLabelKey(env)) : '',
                c.readOnly ? t('app.readOnlyOn') : '',
                c.pending > 0 ? t('tx.clickToReview', { n: c.pending }) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
              onClick={() => !isActive && onSelect(c)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ connId: c.connId, top: e.clientY, left: e.clientX });
              }}
            >
              {c.readOnly && (
                <span className="db-rail-lock" aria-hidden title={t('app.readOnlyOn')}>
                  <Lock size={11} strokeWidth={2.4} />
                </span>
              )}
              <span className="db-rail-icon">
                {Icon ? <Icon size={20} /> : <Database size={20} strokeWidth={1.6} />}
              </span>
              <span className="db-rail-name">{c.db}</span>
              {/* The badge is why the rail exists as more than a switcher: with one control on the
                  title bar the other connections' uncommitted work is invisible, and the user can be
                  holding three open transactions while seeing one. */}
              {c.pending > 0 && (
                <span className="db-rail-badge" aria-hidden>
                  {c.pending > 99 ? '99+' : c.pending}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Through a portal, like every other menu here: the rail sits inside panels that use
          `backdrop-filter`, and that property makes a new containing block — a `position: fixed`
          menu rendered inside would be clipped to the rail's 64px column. */}
      {menu &&
        createPortal(
          <>
            <div className="db-rail-menu-backdrop" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
            <div className="db-rail-menu" style={{ top: menu.top, left: menu.left }} role="menu">
              <button
                type="button"
                className="context-menu-item"
                role="menuitem"
                onClick={() => { closeMenu(); onClose(menu.connId); }}
              >
                {t('sidebar.closeConnection')}
              </button>
              <button
                type="button"
                className="context-menu-item"
                role="menuitem"
                onClick={() => { closeMenu(); void onToggleReadOnly(menu.connId); }}
              >
                {menuConn?.readOnly ? t('sidebar.allowWrites') : t('sidebar.makeReadOnly')}
              </button>
              <button
                type="button"
                className="context-menu-item"
                role="menuitem"
                disabled={connections.length < 2}
                onClick={() => { closeMenu(); onCloseOthers(menu.connId); }}
              >
                {t('sidebar.closeOtherConnections')}
              </button>
            </div>
          </>,
          document.body,
        )}
    </>
  );
};
