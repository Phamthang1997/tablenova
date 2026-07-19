import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { TerminalPanel } from './components/TerminalPanel';
import type { DbConnectionConfig } from './utils/dbHelper';

// Root cho cửa sổ OS riêng chỉ chứa Terminal (mở qua openTerminalWindow -> ?term=<json>).
export const TerminalWindow: React.FC<{ raw: string }> = ({ raw }) => {
  let config: DbConnectionConfig = { type: 'sqlite' };
  let profileName: string | undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    config = parsed.config || config;
    profileName = parsed.profileName;
  } catch {
    /* payload hỏng -> mở shell local mặc định */
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#1c1c1e' }}>
      <TerminalPanel
        config={config}
        profileName={profileName}
        inOwnWindow
        onClose={() => { void getCurrentWindow().close(); }}
      />
    </div>
  );
};
