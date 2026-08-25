// Quick Fix (lightbulb / Ctrl+.) for diagnostics produced by `inspection.ts`.
//
// Fix calculations are pre-computed by `inspectSqlText()` in `issue.fix` (`QuickFixData`).
// This file solely adapts `fix` payloads into Monaco `CodeAction` objects.
// Complex heuristics (fuzzy candidates, replacement ranges) reside in tested pure functions.

//
// Avoids parsing `context.markers`: localized strings break identifier extraction in multilingual UIs.
// Re-running `inspectSqlText` on current buffer is cheaper and reliable.

import type * as monaco from 'monaco-editor';
import { inspectSqlText } from './inspection';
import { LANG_IDS } from './sqlLanguage';
import i18n from '../i18n';

/** Line/column range used for intersection checks. */
interface Span {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * Does diagnostic range intersect requested cursor position / selection?
 *
 * Compares against **underlined squiggly range** rather than replacement target.
 * For column typos, squiggly covers `u.nmae` while replacement is `nmae`. Matching the squiggly
 * ensures placing cursor on `u` still surfaces the fix correctly.
 
 */
function intersects(span: Span, range: monaco.IRange): boolean {
  if (span.endLine < range.startLineNumber || span.startLine > range.endLineNumber) return false;
  if (span.endLine === range.startLineNumber && span.endColumn < range.startColumn) return false;
  if (span.startLine === range.endLineNumber && span.startColumn > range.endColumn) return false;
  return true;
}

/**
 * Registers code action provider for all 3 SQL dialects.
 *
 * Deduplication flag stored on `window` to prevent duplicate actions across Vite HMR cycles.
 
 
 */
export function registerSqlQuickFix(monacoInstance: typeof monaco): void {
  const w = window as any;
  if (Array.isArray(w.__sqlQuickFixDisposables)) {
    for (const d of w.__sqlQuickFixDisposables) {
      try { d.dispose(); } catch { /* already disposed */ }
    }
  }

  const provider: monaco.languages.CodeActionProvider = {
    provideCodeActions(model, range) {
      if (model.isDisposed()) return { actions: [], dispose: () => {} };

      const actions: monaco.languages.CodeAction[] = [];
      for (const issue of inspectSqlText(model.getValue())) {
        const fix = issue.fix;
        if (!fix || !intersects(issue, range)) continue;

        for (const candidate of fix.candidates) {
          actions.push({
            title: i18n.t('sqlEditor.quickFixReplaceWith', { n: candidate }),
            kind: 'quickfix',
            edit: {
              edits: [{
                resource: model.uri,
                versionId: model.getVersionId(),
                textEdit: {
                  range: {
                    startLineNumber: fix.startLine,
                    startColumn: fix.startColumn,
                    endLineNumber: fix.endLine,
                    endColumn: fix.endColumn,
                  },
                  text: candidate,
                },
              }],
            },
          });
        }
      }

      // First candidate is closest match; marked `isPreferred` for immediate acceptance on Ctrl+. + Enter.
      if (actions.length) actions[0].isPreferred = true;
      return { actions, dispose: () => {} };
    },
  };

  w.__sqlQuickFixDisposables = LANG_IDS.map((lang) =>
    monacoInstance.languages.registerCodeActionProvider(lang, provider, {
      providedCodeActionKinds: ['quickfix'],
    }),
  );
}
