import { invoke } from '@tauri-apps/api/core';
import i18n from '../i18n';

/**
 * select thư mục save and write tệp xuất ra đó.
 *
 * not dùng npm wrapper of plugin dialog/fs (dự án chỉ có phần Rust of hai plugin
 * này) nên gọi thẳng command `plugin:dialog|open` / `plugin:fs|write_file`.
 * if write trực tiếp is chặn (quyền/scope) thì lùi về download qua WebView to not mất tệp.
 */

const LAST_DIR_KEY = 'tablenova.export.lastDir';

/** Thư mục xuất dùng lần trước (hiện sẵn in popup for lần sau). */
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
    /* localStorage is chặn -> skip, chỉ mất tiện lợi */
  }
}

/**
 * open hộp thoại select tệp of hệ điều hành.
 * returns đường dẫn tệp already select, or null if user cancel / not có backend Tauri.
 */
export async function pickOpenFile(options?: {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  try {
    const res = await invoke<string | string[] | null>('plugin:dialog|open', {
      options: {
        directory: false,
        multiple: false,
        title: options?.title || 'Chọn tệp',
        defaultPath: options?.defaultPath || undefined,
        filters: options?.filters,
      },
    });
    const file = Array.isArray(res) ? res[0] : res;
    return file || null;
  } catch {
    return null;
  }
}

/**
 * select tệp database SQLite (.db, .sqlite, .sqlite3, .db3, .s3db).
 */
export async function pickSqliteDatabaseFile(defaultPath?: string): Promise<string | null> {
  return pickOpenFile({
    title: 'Chọn tệp SQLite',
    defaultPath,
    filters: [
      {
        name: 'SQLite Database (*.db, *.sqlite, *.sqlite3, *.db3, *.s3db)',
        extensions: ['db', 'sqlite', 'sqlite3', 'db3', 's3db'],
      },
      {
        name: 'All Files (*.*)',
        extensions: ['*'],
      },
    ],
  });
}

/**
 * open hộp thoại select thư mục of hệ điều hành.
 * returns đường dẫn already select, or null if user cancel / not có backend Tauri.
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

/**
 * open hộp thoại "save tệp" (Save As) of hệ điều hành.
 * allows user select thư mục and đặt/edit tên tệp.
 */
export async function pickSaveFilePath(
  defaultName: string,
  ext: string,
  filterName = 'Tệp'
): Promise<string | null> {
  try {
    const fullName = defaultName.endsWith(`.${ext}`) ? defaultName : `${defaultName}.${ext}`;
    const lastDir = getLastExportDir();
    const defaultPath = lastDir ? joinPath(lastDir, fullName) : fullName;

    const res = await invoke<string | null>('plugin:dialog|save', {
      options: {
        title: 'Lưu tệp',
        defaultPath,
        filters: [
          {
            name: filterName,
            extensions: [ext],
          },
        ],
      },
    });
    if (res) {
      const sepIdx = Math.max(res.lastIndexOf('/'), res.lastIndexOf('\\'));
      if (sepIdx > 0) {
        rememberExportDir(res.substring(0, sepIdx));
      }
    }
    return res || null;
  } catch {
    return null;
  }
}

/** write dữ liệu trực tiếp tới đường dẫn đầy đủ do Save As dialog returns. */
export async function saveExportFileAtPath(
  filePath: string,
  data: Uint8Array | string,
  mime = 'application/octet-stream'
): Promise<boolean> {
  try {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await invoke('plugin:fs|write_file', bytes, {
      headers: {
        path: encodeURIComponent(filePath),
        options: JSON.stringify({}),
      },
    });
    return true;
  } catch {
    const sepIdx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const fileName = sepIdx >= 0 ? filePath.substring(sepIdx + 1) : filePath;
    downloadViaWebview(fileName, data, mime);
    return false;
  }
}

/** Nối thư mục + tên tệp, giữ đúng dấu phân cách of đường dẫn currently dùng. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('\\') || dir.endsWith('/') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** download tệp qua WebView (thư mục Downloads / hộp thoại of WebView2). */
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
  /** 'folder' = already write ando thư mục already select; 'download' = must lùi về download qua WebView. */
  savedTo: 'folder' | 'download';
  /** Đường dẫn đầy đủ when write is ando thư mục. */
  path?: string;
  /** Thư mục chứa tệp (thư mục already select, or thư mục download xuống of hệ thống). */
  dir?: string;
  /** Lý do not write is ando thư mục (if có). */
  fallbackReason?: string;
}

/** Nén text thành gzip bằng CompressionStream of WebView (Chromium). */
export async function gzipText(text: string): Promise<Uint8Array> {
  const CS = (globalThis as any).CompressionStream;
  if (!CS) throw new Error(i18n.t('errors.noGzipSupport'));
  const stream = new Blob([text]).stream().pipeThrough(new CS('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Thư mục download xuống of hệ thống (to open when tệp đi qua WebView). Rỗng if not lấy is. */
export async function resolveDownloadDir(): Promise<string> {
  try {
    const { downloadDir } = await import('@tauri-apps/api/path');
    return await downloadDir();
  } catch {
    return '';
  }
}

/** open thư mục (or tệp) bằng trình quản lý tệp of hệ thống. */
export async function openInFileManager(pathOrDir: string): Promise<boolean> {
  try {
    await invoke('open_url', { url: pathOrDir });
    return true;
  } catch {
    return false;
  }
}

/**
 * write tệp xuất: có thư mục thì write thẳng ando đó, not thì download qua WebView.
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
    // Cùng dạng gọi with @tauri-apps/plugin-fs: nội dung đi at body, path/options at headers.
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
