import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { DbConnectionConfig } from './dbHelper';

// Opens Terminal in a STANDALONE OS WINDOW (like VS Code "New Terminal Window").
// Backend PTY session is shared process-wide allowing independent window rendering.
// Configuration passed via ?term=<json> query string for self-initialization.
export function openTerminalWindow(config: DbConnectionConfig, profileName?: string) {
  const payload = encodeURIComponent(JSON.stringify({ config, profileName }));
  const label = `terminal_${crypto.randomUUID()}`;
  new WebviewWindow(label, {
    url: `index.html?term=${payload}`,
    title: profileName ? `Terminal — ${profileName}` : 'Terminal',
    width: 900,
    height: 520,
  });
}
