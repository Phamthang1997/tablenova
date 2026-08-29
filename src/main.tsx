import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Side-effect import: initialises i18next before the first render, for both the
// main window and the standalone terminal window below.
import './i18n'
import App from './App.tsx'
import { TerminalWindow } from './TerminalWindow.tsx'

// If opened as a standalone Terminal window (?term=...), render only the Terminal root.
const termParam = new URLSearchParams(window.location.search).get('term');

// Disable default webview context menu (except on input, textarea, and Monaco Editor)
//
// The exemption exists for cut/copy/paste, so it is granted only where one of those is actually on
// offer. A field the user cannot type into, with nothing selected, has none — and Chrome then falls
// back to its *page* menu (Back / Refresh / Save as / Print / Send tab to your devices / Inspect),
// which is browser chrome leaking into the app rather than an edit menu. A read-only value box
// (`ValuePanel`'s textarea whenever the format is a projection, e.g. `Format: json`) hit exactly
// that. With a selection the same field does offer Copy, so that case stays exempt.
function wantsNativeMenu(el: HTMLElement): boolean {
  if (el.closest('.monaco-editor') || el.isContentEditable) return true;
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  if (field.disabled) return false;
  if (!field.readOnly) return true;
  // `selectionStart` is null on input types that do not support it (number, email…); those are
  // never read-only value displays, so treating "no selection API" as "no selection" is right.
  return field.selectionStart != null && field.selectionStart !== field.selectionEnd;
}

document.addEventListener('contextmenu', (e) => {
  if (wantsNativeMenu(e.target as HTMLElement)) return;
  e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {termParam ? <TerminalWindow raw={termParam} /> : <App />}
  </StrictMode>,
)
