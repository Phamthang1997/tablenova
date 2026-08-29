import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { DbConnectionConfig } from './dbHelper';

// Opens Terminal in a STANDALONE OS WINDOW (like VS Code "New Terminal Window").
// Backend PTY session is shared process-wide allowing independent window rendering.
// Configuration passed via ?term=<json> query string for self-initialization.
export function openTerminalWindow(config: DbConnectionConfig, profileName?: string) {
  const payload = encodeURIComponent(JSON.stringify({ config, profileName }));
  const label = `terminal_${crypto.randomUUID()}`;
  // no-new: constructing a `WebviewWindow` IS how Tauri opens one - there is no `.open()` to call and
  // nothing to keep, since the window owns itself from here on. Assigning it to a throwaway variable
  // to satisfy the rule would say less, not more.
  // eslint-disable-next-line no-new
  new WebviewWindow(label, {
    url: `index.html?term=${payload}`,
    title: profileName ? `Terminal — ${profileName}` : 'Terminal',
    width: 900,
    height: 520,
  });
}
