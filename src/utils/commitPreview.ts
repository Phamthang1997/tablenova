// Có hiện hộp thoại "xem trước SQL" trước khi grid lưu hay không, lưu **theo server** (`connKey`).
//
// Mặc định là **bật**, đúng hành vi có từ trước. Theo server chứ không phải một cờ toàn app, vì đó
// là lằn ranh thật: người ta muốn đọc lại từng câu UPDATE trên production và không muốn bị chặn hai
// nhịp trên một DB local. Cùng lý do đó, công tắc nằm trong popover Safe Mode — chỗ đã giữ mức hỏi
// và giới hạn thời gian câu lệnh của đúng kết nối đang xem.
//
// Tắt hộp thoại này KHÔNG tắt Safe Mode: `commit_changes` vẫn qua cổng như trước, nên ở mức
// `writes`/`all` vẫn còn một lần hỏi. Hai thứ trả lời hai câu khác nhau — "SQL sắp chạy là gì" và
// "có cho nó chạy không" — nên tắt cái này không được kéo theo cái kia.

import { createConnPref } from './connPrefs';

// Chỉ `false` được lưu; mặc định `true` thì entry bị xoá (xem `createConnPref`).
const pref = createConnPref<boolean>('tf_commit_preview', 'commit-preview-changed', true, (raw) =>
  raw === false ? false : null,
);

export const COMMIT_PREVIEW_CHANGED_EVENT = pref.EVENT;

/** Có hiện hộp thoại xem trước cho server này không. */
export const getCommitPreviewForKey = (key: string): boolean => pref.get(key);

export const setCommitPreviewForKey = (key: string, on: boolean): void => pref.set(key, on);
