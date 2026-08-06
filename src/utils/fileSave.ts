import { invoke } from '@tauri-apps/api/core';
import i18n from '../i18n';

/**
 * Chọn thư mục lưu và ghi tệp xuất ra đó.
 *
 * Không dùng npm wrapper của plugin dialog/fs (dự án chỉ có phần Rust của hai plugin
 * này) nên gọi thẳng command `plugin:dialog|open` / `plugin:fs|write_file`.
 * Nếu ghi trực tiếp bị chặn (quyền/scope) thì lùi về tải qua WebView để không mất tệp.
 */

const LAST_DIR_KEY = 'tablenova.export.lastDir';

/** Thư mục xuất dùng lần trước (hiện sẵn trong popup cho lần sau). */
export function getLastExportDir(): string {
  try {
    return localStorage.getItem(LAST_DIR_KEY) || '';
  } catch {
    return '';
  }
}

function rememberExportDir(dir: string): void {
  try {
    localStorage.setItem(LAST_DIR_KEY, dir);
  } catch {
    /* localStorage bị chặn -> bỏ qua, chỉ mất tiện lợi */
  }
}

/**
 * Mở hộp thoại chọn thư mục của hệ điều hành.
 * Trả về đường dẫn đã chọn, hoặc null nếu người dùng huỷ / không có backend Tauri.
 */
export async function pickExportFolder(defaultPath?: string): Promise<string | null> {
  try {
    const res = await invoke<string | string[] | null>('plugin:dialog|open', {
      options: {
        directory: true,
        multiple: false,
        recursive: false,
        title: 'Chọn thư mục lưu tệp xuất',
        defaultPath: defaultPath || undefined,
      },
    });
    const dir = Array.isArray(res) ? res[0] : res;
    if (!dir) return null;
    rememberExportDir(dir);
    return dir;
  } catch {
    return null;
  }
}

/** Nối thư mục + tên tệp, giữ đúng dấu phân cách của đường dẫn đang dùng. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('\\') || dir.endsWith('/') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Tải tệp qua WebView (thư mục Downloads / hộp thoại của WebView2). */
function downloadViaWebview(name: string, data: Uint8Array | string, mime: string): void {
  const blob = typeof data === 'string'
    ? new Blob([data], { type: mime })
    : new Blob([data.slice().buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface SaveResult {
  /** 'folder' = đã ghi vào thư mục đã chọn; 'download' = phải lùi về tải qua WebView. */
  savedTo: 'folder' | 'download';
  /** Đường dẫn đầy đủ khi ghi được vào thư mục. */
  path?: string;
  /** Thư mục chứa tệp (thư mục đã chọn, hoặc thư mục tải xuống của hệ thống). */
  dir?: string;
  /** Lý do không ghi được vào thư mục (nếu có). */
  fallbackReason?: string;
}

/** Nén text thành gzip bằng CompressionStream của WebView (Chromium). */
export async function gzipText(text: string): Promise<Uint8Array> {
  const CS = (globalThis as any).CompressionStream;
  if (!CS) throw new Error(i18n.t('errors.noGzipSupport'));
  const stream = new Blob([text]).stream().pipeThrough(new CS('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Thư mục tải xuống của hệ thống (để mở khi tệp đi qua WebView). Rỗng nếu không lấy được. */
export async function resolveDownloadDir(): Promise<string> {
  try {
    const { downloadDir } = await import('@tauri-apps/api/path');
    return await downloadDir();
  } catch {
    return '';
  }
}

/** Mở thư mục (hoặc tệp) bằng trình quản lý tệp của hệ thống. */
export async function openInFileManager(pathOrDir: string): Promise<boolean> {
  try {
    await invoke('open_url', { url: pathOrDir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ghi tệp xuất: có thư mục thì ghi thẳng vào đó, không thì tải qua WebView.
 */
export async function saveExportFile(
  dir: string | null,
  name: string,
  data: Uint8Array | string,
  mime = 'application/octet-stream'
): Promise<SaveResult> {
  if (!dir) {
    downloadViaWebview(name, data, mime);
    return { savedTo: 'download', dir: await resolveDownloadDir() };
  }

  const path = joinPath(dir, name);
  try {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    // Cùng dạng gọi với @tauri-apps/plugin-fs: nội dung đi ở body, path/options ở headers.
    await invoke('plugin:fs|write_file', bytes, {
      headers: {
        path: encodeURIComponent(path),
        options: JSON.stringify({}),
      },
    });
    rememberExportDir(dir);
    return { savedTo: 'folder', path, dir };
  } catch (err: any) {
    downloadViaWebview(name, data, mime);
    return {
      savedTo: 'download',
      dir: await resolveDownloadDir(),
      fallbackReason: err?.message || String(err),
    };
  }
}
