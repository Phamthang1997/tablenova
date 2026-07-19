import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { DbConnectionConfig } from './dbHelper';

// Mở Terminal trong MỘT CỬA SỔ OS RIÊNG (như "New Terminal Window" của VS Code).
// Phiên PTY nằm ở backend Rust dùng chung cho cả process nên cửa sổ mới mở/đọc terminal độc lập.
// Cấu hình được truyền qua query string ?term=<json> để cửa sổ mới tự khởi tạo phiên.
export function openTerminalWindow(config: DbConnectionConfig, profileName?: string) {
  const payload = encodeURIComponent(JSON.stringify({ config, profileName }));
  const label = `terminal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  new WebviewWindow(label, {
    url: `index.html?term=${payload}`,
    title: profileName ? `Terminal — ${profileName}` : 'Terminal',
    width: 900,
    height: 520,
  });
}
