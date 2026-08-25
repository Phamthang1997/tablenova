// `redis` language for Monaco: syntax highlighting, command autocompletion, and hover docs.
//
// Why custom implementation instead of `monaco-sql-languages`: that package is ANTLR-based for SQL dialects.
// Redis protocol has no complex grammar — one command per line, followed by space-separated arguments.
// A ~20-line monarch tokenizer accurately models this without pretending to parse AST.

//
// Data source is `COMMANDS` in `commandHelp.ts` — pre-existing table (149 commands with parameters,
// complexity, versions), preventing duplicate registry drift.

import * as monaco from 'monaco-editor';
import { COMMANDS, commandSyntax } from './commandHelp';
import { commandNameOf } from './redisScript';

export const REDIS_LANG_ID = 'redis';

/** Known command names, used by both tokenizer and `commandNameOf`. */
const KNOWN = COMMANDS.map((c) => c.name);

/** First word of each command — tokenizer processes one token at a time. */
const HEADS = Array.from(new Set(KNOWN.map((n) => n.split(' ')[0])));

/** Second word of two-word commands (GET in CONFIG GET, LIST in CLIENT LIST...). */
const SUBS = Array.from(
  new Set(KNOWN.filter((n) => n.includes(' ')).map((n) => n.split(' ')[1])),
);

let registered = false;

/**
 * Registers once globally for the app.
 *
 * Monaco is a global singleton: calling `register` repeatedly on same id stacks duplicate providers,
 * multiplying suggestions. Module-level flag mirrors `sqlLanguage.ts` pattern.
 */
export function registerRedisLanguage(): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: REDIS_LANG_ID });

  monaco.languages.setLanguageConfiguration(REDIS_LANG_ID, {
    comments: { lineComment: '#' },
    brackets: [['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider(REDIS_LANG_ID, {
    ignoreCase: true,
    keywords: HEADS,
    subCommands: SUBS,
    tokenizer: {
      root: [
        // Comments only recognized at line START — `SET k a#b` is a valid string value; highlighting second half
        // as comment misleads user into thinking it is ignored. Matches `splitRedisCommands` rule.
        
        [/^\s*#.*$/, 'comment'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [
          /[a-zA-Z][\w.-]*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@subCommands': 'keyword',
              '@default': 'identifier',
            },
          },
        ],
      ],
    },
  });

  monaco.languages.registerCompletionItemProvider(REDIS_LANG_ID, {
    provideCompletionItems(model, position) {
      const upto = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      // Only triggers suggestions when typing command name. Whitespace denotes argument position —
      // keys and values are user data where auto-suggesting 149 command names
      // would obstruct typing.
      //
      // Exception: two-word commands. After `CONFIG `, subsequent word is still a command keyword.
      const word = model.getWordUntilPosition(position);
      const head = upto.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
      const typingSecondWord =
        upto.trim().split(/\s+/).length <= 2 && KNOWN.some((n) => n.startsWith(head + ' '));
      if (upto.includes(' ') && !typingSecondWord) return { suggestions: [] };

      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      return {
        suggestions: COMMANDS.map((c) => ({
          label: c.name,
          kind: monaco.languages.CompletionItemKind.Function,
          // Inserts command name + trailing space when command takes arguments for seamless typing.
          insertText: c.args ? `${c.name} ` : c.name,
          detail: c.args,
          documentation: c.description
            ? { value: [c.description, c.complexity ? `\n\n⏱ ${c.complexity}` : ''].join('') }
            : undefined,
          range,
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider(REDIS_LANG_ID, {
    provideHover(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const name = commandNameOf(line, KNOWN);
      const entry = commandSyntax(name);
      if (!entry) return null;
      const parts = [`**${entry.name}** ${entry.args}`.trim()];
      if (entry.description) parts.push(entry.description);
      if (entry.complexity) parts.push(`⏱ ${entry.complexity}`);
      if (entry.since) parts.push(`_since ${entry.since}_`);
      return { contents: parts.map((value) => ({ value })) };
    },
  });
}
