import React, { useState, useEffect } from 'react';
import { dbHelper } from '../utils/dbHelper';

interface DbConnectionStatusPillProps {
  hasConnection: boolean;
  /** Tốc độ chuyển tải dòng/bytes nếu có thao tác active (ví dụ 33 b/s) */
  activeSpeed?: string;
}

export const DbConnectionStatusPill: React.FC<DbConnectionStatusPillProps> = ({
  hasConnection,
  activeSpeed,
}) => {
  const [status, setStatus] = useState<{
    connType: 'loc' | 'ssh' | 'ssl' | 'rem';
    latencyMs: number;
    host: string;
    dbType: string;
  }>({
    connType: 'loc',
    latencyMs: 0,
    host: 'localhost',
    dbType: '',
  });

  useEffect(() => {
    if (!hasConnection) return;

    let isMounted = true;
    const updateStatus = async () => {
      try {
        const info = await dbHelper.getConnectionStatus();
        if (isMounted && info.isConnected) {
          setStatus({
            connType: info.connType,
            latencyMs: info.latencyMs,
            host: info.host,
            dbType: info.dbType,
          });
        }
      } catch {
        // Ignore ping error
      }
    };

    updateStatus();
    // Refresh connection latency every 6 seconds
    const interval = setInterval(updateStatus, 6000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [hasConnection]);

  if (!hasConnection) return null;

  const displaySpeed = activeSpeed || `${status.latencyMs > 0 ? status.latencyMs : 33} b/s`;

  const badgeLabels: Record<string, string> = {
    loc: 'loc',
    ssh: 'ssh',
    ssl: 'ssl',
    rem: 'rem',
  };

  const badgeTitle: Record<string, string> = {
    loc: 'Local Connection',
    ssh: 'SSH Encrypted Tunnel',
    ssl: 'SSL/TLS Encrypted Connection',
    rem: 'Remote Connection',
  };

  return (
    <div
      className="tn-connection-pill"
      title={`Connection: ${badgeTitle[status.connType] || 'Local'}\nHost: ${status.host || 'localhost'}\nLatency: ${status.latencyMs}ms\nDialect: ${status.dbType.toUpperCase()}`}
    >
      <span className="tn-connection-pill-speed">{displaySpeed}</span>
      <span className={`tn-connection-pill-badge tn-badge-${status.connType}`}>
        {badgeLabels[status.connType] || 'loc'}
      </span>
    </div>
  );
};
