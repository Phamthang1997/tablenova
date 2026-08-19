/**
 * Telling MySQL apart from MariaDB.
 *
 * The backend reports both as `db_type = "mysql"`: they speak the same wire protocol and share
 * every branch in `database.rs`, so there is deliberately no `'mariadb'` value in the frontend's
 * `dbType` union either. The version string is the only thing that distinguishes them, and the
 * only reason to care is the handful of features one has and the other does not — sequences being
 * the first (`CREATE SEQUENCE` is MariaDB 10.3+, MySQL has no such statement).
 *
 * MariaDB always spells its name in `VERSION()`:
 *   "10.11.6-MariaDB-1:10.11.6+maria~ubu2204"
 *   "5.5.5-10.4.32-MariaDB"   (the fake 5.5.5 prefix older servers report for old-client compat)
 * MySQL never does:
 *   "8.0.35", "8.4.3-0ubuntu0.24.04.1", "5.7.44-log"
 */
export function isMariaDbVersion(version?: string | null): boolean {
  return !!version && version.toLowerCase().includes('mariadb');
}
