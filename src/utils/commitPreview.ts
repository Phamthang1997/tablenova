// Có hiện hộp thoại "preview SQL" trước when grid save hay not, save **theo server** (`connKey`).
//
// default is **bật**, đúng hành vi có from trước. Theo server chứ not must một cờ toàn app, vì đó
// is lằn ranh thật: người ta muốn read lại fromng câu UPDATE on production and not muốn is chặn hai
// nhịp on một DB local. Cùng lý do đó, công tắc nằm in popover Safe Mode — chỗ already giữ mức hỏi
// and limit time statement of đúng kết nối currently xem.
//
// Tắt hộp thoại này not tắt Safe Mode: `commit_changes` vẫn qua cổng như trước, nên at mức
// `writes`/`all` vẫn còn một lần hỏi. Hai thứ trả lời hai câu khác nhau — "SQL sắp run is gì" and
// "có for nó run not" — nên tắt cái này not is kéo theo cái kia.

import { createConnPref } from './connPrefs';

// Chỉ `false` is save; default `true` thì entry is delete (xem `createConnPref`).
const pref = createConnPref<boolean>('tf_commit_preview', 'commit-preview-changed', true, (raw) =>
  raw === false ? false : null,
);

export const COMMIT_PREVIEW_CHANGED_EVENT = pref.EVENT;

/** Có hiện hộp thoại preview for server này not. */
export const getCommitPreviewForKey = (key: string): boolean => pref.get(key);

export const setCommitPreviewForKey = (key: string, on: boolean): void => pref.set(key, on);
