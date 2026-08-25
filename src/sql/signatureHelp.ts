// Parameter hints (Signature Help): typing `DATE_ADD(` displays syntax signature and
// parameter descriptions, highlighting the active parameter index.
//
// Data sourced from `docsService`, matching hover and completion documentation.
// Active argument index resolved by `enclosingCall()` in `statements.ts`.


import type * as monaco from 'monaco-editor';
import { enclosingCall } from './statements';
import { LANG_IDS } from './sqlLanguage';
import { getDoc, getDocSummary, getParamDesc } from '../utils/docsService';
import i18n, { currentLanguage } from '../i18n';

/**
 * Registers signature help provider for all 3 SQL dialects.
 *
 * Anti-duplicate flag stored on `window` to avoid duplicate registrations during Vite HMR.
 
 */
export function registerSqlSignatureHelp(monacoInstance: typeof monaco): void {
  const w = window as any;
  if (Array.isArray(w.__sqlSignatureDisposables)) {
    for (const d of w.__sqlSignatureDisposables) {
      try { d.dispose(); } catch { /* already disposed */ }
    }
  }

  const provider: monaco.languages.SignatureHelpProvider = {
    // `,` advances parameter index; `)` retriggers to dismiss hints when function call closes.
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],

    provideSignatureHelp(model, position) {
      const call = enclosingCall(model.getValue(), model.getOffsetAt(position));
      if (!call) return null;

      const doc = getDoc(call.name, model.getLanguageId());
      if (!doc) return null;

      const lang = currentLanguage();
      const parameters = (doc.params || []).map((p) => ({
        // Parameter labels: Monaco highlights active argument matching substring in signature label.
        
        label: p.name,
        documentation: {
          value: `${p.type ? `\`${p.type}\`${p.optional ? ` _(${i18n.t('sqlEditor.paramOptional')})_` : ''} — ` : ''}${getParamDesc(p, lang)}`,
        },
      }));

      return {
        value: {
          signatures: [{
            label: doc.syntax,
            documentation: { value: getDocSummary(doc, lang) },
            parameters,
          }],
          activeSignature: 0,
          // Clamps index: variadic functions (`CONCAT(a, b, c, ...)`) clamp extra arguments to final parameter.
          
          activeParameter: Math.min(call.activeParam, Math.max(0, parameters.length - 1)),
        },
        dispose: () => {},
      };
    },
  };

  w.__sqlSignatureDisposables = LANG_IDS.map((lang) =>
    monacoInstance.languages.registerSignatureHelpProvider(lang, provider),
  );
}
