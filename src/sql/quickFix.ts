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
 * Does this diagnostic's range touch the range Monaco is asking about (the caret, or a selection)?
 *
 * Compared against the **underlined** range, not the range that will be replaced. Those differ for
 * a column typo: the underline covers `u.nmae` while the replacement is only `nmae`. The user sees
 * the underline and will put the caret anywhere inside it — accepting only the replacement range
 * would mean Quick Fix on `u` offers nothing, which is indistinguishable from "the feature is
 * broken".
 */
function intersects(span: Span, range: monaco.IRange): boolean {
  if (span.endLine < range.startLineNumber || span.startLine > range.endLineNumber) return false;
  if (span.endLine === range.startLineNumber && span.endColumn < range.startColumn) return false;
  if (span.startLine === range.endLineNumber && span.startColumn > range.endColumn) return false;
  return true;
}

/**
 * Registers the code action provider for all three dialects.
 *
 * The anti-double-registration flag lives on `window` rather than in a module variable, for the
 * same reason as hover: a Vite HMR reload resets module state and the provider gets registered
 * again, which makes every Quick Fix appear as two identical entries.
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
