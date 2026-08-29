// Whether the "preview the SQL" dialog appears before the grid saves, stored **per server**
// (`connKey`).
//
// The default is **on**, matching the behaviour that came before. Per server rather than one app-wide
// flag, because that is where the real line falls: people want to reread every UPDATE against
// production and do not want two extra beats on a local DB. For the same reason the switch lives in
// the Safe Mode popover — which already holds the ask level and the statement time limit of the very
// connection being viewed.
//
// Turning this dialog off does NOT turn Safe Mode off: `commit_changes` still passes the gate as
// before, so at `writes`/`all` there is still one question. The two answer different things — "what
// SQL is about to run" and "may it run" — so switching one off must not drag the other with it.

import { createConnPref } from './connPrefs';

// Only `false` is stored; the `true` default deletes the entry (see `createConnPref`).
const pref = createConnPref<boolean>('tf_commit_preview', 'commit-preview-changed', true, (raw) =>
  raw === false ? false : null,
);

export const COMMIT_PREVIEW_CHANGED_EVENT = pref.EVENT;

/** Whether the preview dialog is shown for this server. */
export const getCommitPreviewForKey = (key: string): boolean => pref.get(key);

export const setCommitPreviewForKey = (key: string, on: boolean): void => pref.set(key, on);
