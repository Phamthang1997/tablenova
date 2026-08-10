import type * as monaco from 'monaco-editor';
import { maskForSplit } from './statements';

/**
 * Replaces occurrences of a table or symbol name in an SQL script, respecting word boundaries and skipping comments/strings.
 */
export function propagateTableRenameInText(
  sqlText: string,
  oldName: string,
  newName: string
): string {
  if (!sqlText || !oldName || !newName || oldName === newName) return sqlText;

  const masked = maskForSplit(sqlText);
  const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');

  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(masked)) !== null) {
    const matchIndex = match.index;
    result += sqlText.slice(lastIndex, matchIndex) + newName;
    lastIndex = matchIndex + oldName.length;
  }

  result += sqlText.slice(lastIndex);
  return result;
}

const TARGET_LANG_IDS = ['sql', 'mysql', 'pgsql', 'genericsql'];

let renameProviderRegistered = false;

/**
 * Registers the Monaco Rename Symbol Provider for F2 shortcut support.
 */
export function registerSqlRenameProvider(monacoInstance: typeof monaco): void {
  if (renameProviderRegistered) return;
  renameProviderRegistered = true;

  const provider: monaco.languages.RenameProvider = {
    provideRenameEdits(model, position, newName) {
      const wordInfo = model.getWordAtPosition(position);
      if (!wordInfo) return null;

      const oldName = wordInfo.word;
      const text = model.getValue();
      const masked = maskForSplit(text);

      const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const edits: monaco.languages.IWorkspaceTextEdit[] = [];
      let match: RegExpExecArray | null;

      while ((match = regex.exec(masked)) !== null) {
        const startPos = model.getPositionAt(match.index);
        const endPos = model.getPositionAt(match.index + oldName.length);

        edits.push({
          resource: model.uri,
          versionId: model.getVersionId(),
          textEdit: {
            range: {
              startLineNumber: startPos.lineNumber,
              startColumn: startPos.column,
              endLineNumber: endPos.lineNumber,
              endColumn: endPos.column,
            },
            text: newName,
          },
        });
      }

      return {
        edits,
      };
    },

    resolveRenameLocation(model, position) {
      const wordInfo = model.getWordAtPosition(position);
      if (!wordInfo) {
        return {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
          text: '',
          rejectReason: 'Cannot rename this element.',
        };
      }

      return {
        range: {
          startLineNumber: position.lineNumber,
          startColumn: wordInfo.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: wordInfo.endColumn,
        },
        text: wordInfo.word,
      };
    },
  };

  for (const langId of TARGET_LANG_IDS) {
    monacoInstance.languages.registerRenameProvider(langId, provider);
  }
}
