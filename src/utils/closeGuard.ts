// Who gets to stop the window from closing, and in what order.
//
// There used to be exactly one such guard (`TxControl`'s "you have uncommitted changes"), so it
// registered `onCloseRequested` itself. Background jobs are a second reason to stop — and two
// independent `onCloseRequested` listeners cannot work: each one calls `preventDefault()` and then
// one of them calls `destroy()`, so whichever resolves first decides, and the other's dialog is
// killed together with the window it was asking about.
//
// So there is **one** listener (`installCloseGuard`, mounted once at the app root) and a list of
// blockers. A blocker returns `true` to mean "I am taking over — I have shown my own dialog"; the
// chain stops there and the window stays open. If every blocker declines, the window closes.
//
// `priority` orders them by how much is at stake, not by mount order: uncommitted rows first
// (irreversible), then a job that would be killed mid-run.

import { getCurrentWindow } from '@tauri-apps/api/window';

/** `true` = blocks window close and prompts user. `false` = safe to proceed. */
export type CloseBlocker = () => boolean | Promise<boolean>;

export const CLOSE_PRIORITY_TX = 10;
export const CLOSE_PRIORITY_JOBS = 20;

interface Registered {
  priority: number;
  fn: CloseBlocker;
}

const blockers = new Set<Registered>();

/** Registers a close blocker. Returns cleanup function for effect disposal. */
export function registerCloseBlocker(priority: number, fn: CloseBlocker): () => void {
  const entry: Registered = { priority, fn };
  blockers.add(entry);
  return () => {
    blockers.delete(entry);
  };
}

/**
 * Ask every blocker in priority order. Stops at the first one that takes over.
 *
 * A blocker that throws is treated as "does not block": a broken guard must not trap the user in an
 * app they cannot close.
 */
export async function askBlockers(): Promise<boolean> {
  const ordered = [...blockers].sort((a, b) => a.priority - b.priority);
  for (const b of ordered) {
    try {
      if (await b.fn()) return true;
    } catch {
      /* skip: guard error should not hold user hostage */
    }
  }
  return false;
}

/** Force closes window immediately without prompts. */
export function forceClose(): void {
  void getCurrentWindow().destroy();
}

/**
 * Registers window close listener. Called once at app root; returns cleanup function.
 *
 * preventDefault() must be called synchronously before awaiting async blockers to prevent premature window closure.
 
 */
export function installCloseGuard(): () => void {
  const un = getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    if (await askBlockers()) return;
    forceClose();
  });
  return () => {
    void un.then((f) => f());
  };
}
