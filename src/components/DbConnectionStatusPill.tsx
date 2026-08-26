import React from 'react';
import type { ConnectionStatus } from '../utils/dbHelper';

interface DbConnectionStatusPillProps {
  /**
   * The session status, polled by TitleBar.
   *
   * The pill used to call `getConnectionStatus` itself every 6 seconds. The connection-details
   * popover needs exactly that data, and so does the line in the middle of the title bar, so the
   * asking moved up to TitleBar — left as it was, each place displaying it would ping the database
   * on a beat of its own.
   */
  status: ConnectionStatus | null;
  /** The row/byte transfer rate while an operation is active (33 b/s, say). */
  activeSpeed?: string;
}

const BADGE_LABELS: Record<string, string> = {
  loc: 'loc',
  ssh: 'ssh',
  ssl: 'ssl',
  rem: 'rem',
};

const BADGE_TITLES: Record<string, string> = {
  loc: 'Local Connection',
  ssh: 'SSH Encrypted Tunnel',
  ssl: 'SSL/TLS Encrypted Connection',
  rem: 'Remote Connection',
};

export const DbConnectionStatusPill: React.FC<DbConnectionStatusPillProps> = ({
  status,
  activeSpeed,
}) => {
  if (!status?.isConnected) return null;

  const displaySpeed = activeSpeed || `${status.latencyMs > 0 ? status.latencyMs : 33} b/s`;

  return (
    <div
      className="tn-connection-pill"
      title={`Connection: ${BADGE_TITLES[status.connType] || 'Local'}\nHost: ${status.host || 'localhost'}\nLatency: ${status.latencyMs}ms\nDialect: ${status.dbType.toUpperCase()}`}
    >
      <span className="tn-connection-pill-speed">{displaySpeed}</span>
      <span className={`tn-connection-pill-badge tn-badge-${status.connType}`}>
        {BADGE_LABELS[status.connType] || 'loc'}
      </span>
    </div>
  );
};
