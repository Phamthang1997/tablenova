import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';

interface DbRailProps {
  /** The database currently open — its cell is highlighted. */
  dbName: string;
  /** How many connections are open. The rail shows from 2 up — see the note below. */
  connectionCount: number;
  onDatabaseChanged: (name: string) => void;
}

/**
 * The narrow column left of the sidebar: every database on the server, one click to switch.
 *
 * The title bar popover (`TitleBar.handleOpenDbPopover`) stays as it was — both call
 * `switch_database`, so there is no state to keep in sync between them.
 *
 * `list_databases` returns an **empty array** for SQLite (1 file = 1 database), so the rail
 * hides itself there without the call site having to check `dbType`.
 *
 * **Only shown when 2 or more connections are open** (`connectionCount`). The backend holds
 * exactly ONE connection (`DatabaseManager.connection`), so in practice the rail is always
 * hidden — the condition is here for when multi-connection lands and the rail finally has
 * something to switch between. With a single connection the title bar popover is enough.
 */
export const DbRail: React.FC<DbRailProps> = ({ dbName, connectionCount, onDatabaseChanged }) => {
  const { t } = useTranslation();
  const [databases, setDatabases] = useState<string[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await dbHelper.listDatabases();
    setDatabases(res.databases || []);
  }, []);

  // Reload on `dbName` change too: restoring a dump, or creating/dropping a database
  // elsewhere, leaves this list stale. `database-restored` is the existing event that
  // Sidebar and DataGrid also listen to (see App.tsx).
  useEffect(() => {
    // Don't ask the backend while the rail is hidden: `list_databases` runs a real query on
    // the active connection, and spending that on a column nobody sees is waste.
    if (connectionCount < 2) {
      setDatabases([]);
      return;
    }
    reload();
    const onRestored = () => { reload(); };
    window.addEventListener('database-restored', onRestored);
    return () => window.removeEventListener('database-restored', onRestored);
  }, [reload, dbName, connectionCount]);

  const handleSwitch = async (name: string) => {
    if (name === dbName || switching) return;
    setSwitching(name);
    try {
      const res = await dbHelper.switchDatabase(name);
      // switch_database refuses while a transaction is open — report exactly what the
      // backend said (already translated at the dbHelper boundary) instead of swallowing
      // the error and leaving the rail pointing at the wrong database.
      if (res.success) onDatabaseChanged(res.database || name);
      else alert(t('sidebar.errSwitchDb', { message: res.error || '' }));
    } finally {
      setSwitching(null);
    }
  };

  // One connection, SQLite (empty array), or the first load not back yet: take no space.
  if (connectionCount < 2 || databases.length === 0) return null;

  return (
    <div className="db-rail" role="listbox" aria-label={t('sidebar.databases')}>
      {databases.map((name) => {
        const isActive = name === dbName;
        return (
          <button
            key={name}
            type="button"
            role="option"
            aria-selected={isActive}
            className={`db-rail-item${isActive ? ' is-on' : ''}`}
            title={isActive ? name : t('sidebar.switchDbHint', { name })}
            onClick={() => handleSwitch(name)}
          >
            <Database size={20} strokeWidth={1.6} />
            <span className="db-rail-name">{name}</span>
          </button>
        );
      })}
      {switching && <div className="db-rail-status">{t('sidebar.switchingDatabase')}</div>}
    </div>
  );
};
