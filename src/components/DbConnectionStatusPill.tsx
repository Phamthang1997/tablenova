import React from 'react';
import type { ConnectionStatus } from '../utils/dbHelper';

interface DbConnectionStatusPillProps {
  /**
   * status phiên, do TitleBar hỏi định kỳ.
   *
   * Pill trước đây tự gọi `getConnectionStatus` mỗi 6 giây. Popover chi tiết
   * kết nối cần đúng dữ liệu đó, and row chữ giữa title bar cũng vậy, nên
   * việc hỏi is đưa lên TitleBar — if to nguyên thì mỗi chỗ display lại
   * ping database một nhịp riêng.
   */
  status: ConnectionStatus | null;
  /** Tốc độ chuyển download row/bytes if có thao tác active (ví dụ 33 b/s) */
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
