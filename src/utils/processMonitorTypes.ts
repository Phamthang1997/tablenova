// Type definitions and helper functions for Live Processlist & Query Monitor.

export interface ProcessItem {
  /** Session or Process ID (PID in PostgreSQL, ID in MySQL, connection index in SQLite) */
  id: string;
  /** Authenticated user/role */
  user: string;
  /** Client IP or hostname */
  host: string;
  /** Current active database or catalog */
  db: string;
  /** Command type (e.g., Query, Sleep, Execute, client backend) */
  command: string;
  /** Elapsed execution time in seconds */
  time_seconds: number;
  /** Session state (e.g., active, idle, idle in transaction, waiting) */
  state: string;
  /** Full or partial SQL query text */
  info: string;
  /** PostgreSQL wait event / MySQL lock info if available */
  wait_event?: string | null;
  /** Whether this query is blocked waiting on another transaction/lock */
  is_blocked: boolean;
  /** Identifier of the blocker process/PID if detected */
  blocked_by?: string | null;
}

export interface ProcessListSummary {
  /** Database dialect: postgres, mysql, sqlite */
  dialect: string;
  /** Total number of open sessions/connections reported by the server */
  total_connections: number;
  /** Number of sessions actively executing queries */
  active_queries: number;
  /** Number of sessions currently blocked by locks */
  blocked_queries: number;
  /** Longest running query duration in seconds */
  longest_running_seconds: number;
  /** List of individual process/session items */
  processes: ProcessItem[];
}

export interface KillResult {
  success: boolean;
  target_id: string;
  action: 'cancel_query' | 'kill_connection';
  message: string;
}

/** Format duration in seconds to clean human-readable text */
export function formatProcessDuration(seconds: number): string {
  if (seconds < 0) return '0s';
  if (seconds < 1) {
    const ms = Math.round(seconds * 1000);
    return `${ms}ms`;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const remSec = Math.floor(seconds % 60);
  if (mins < 60) {
    return `${mins}m ${remSec}s`;
  }
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hours}h ${remMin}m`;
}

/** Check whether a process session is actively running an actual SQL query */
export function isQueryActive(proc: ProcessItem): boolean {
  const s = proc.state.toLowerCase();
  const c = proc.command.toLowerCase();
  const u = proc.user.toLowerCase();
  if (u === 'event_scheduler' || u === 'system user') return false;
  if (
    s.includes('idle') ||
    s.includes('sleep') ||
    s.includes('waiting on empty queue') ||
    c === 'sleep' ||
    c === 'daemon' ||
    c === 'binlog dump'
  ) {
    return false;
  }
  return c === 'query' || c === 'execute' || (!proc.info.trim().startsWith('--') && proc.info.trim().length > 0);
}

/** Determine severity level based on elapsed query runtime */
export function getDurationSeverity(
  seconds: number,
  state: string,
  isActive = true
): 'normal' | 'warning' | 'critical' {
  if (!isActive) return 'normal';
  const s = state.toLowerCase();
  if (s.includes('idle') || s.includes('sleep') || s.includes('waiting on empty queue')) return 'normal';
  if (seconds >= 60) return 'critical';
  if (seconds >= 10) return 'warning';
  return 'normal';
}

