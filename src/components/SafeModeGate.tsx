import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import {
  setSafeModeConfirmer,
  STATEMENT_PREVIEW_CAP,
  type SafeModeRequest,
} from '../utils/safeMode';
import type { UnsafeStatementKind } from '../sql/statements';

/**
 * The dialog Safe Mode asks through. Mounted once, near the root: `safeMode.ts` is a plain module
 * with no React in it, so it holds a registered confirmer instead of importing a dialog — the same
 * shape as `queryHistory`'s event, one level up.
 *
 * One prompt per *action*, never per statement: running a 500-statement file asks once and shows
 * the counts. Asking 500 times is the fastest way to get the feature switched off.
 */
export const SafeModeGate: React.FC = () => {
  const { t } = useTranslation();
  const [pending, setPending] = useState<{
    req: SafeModeRequest;
    resolve: (ok: boolean) => void;
  } | null>(null);

  useEffect(() => {
    setSafeModeConfirmer(
      (req) =>
        new Promise<boolean>((resolve) => {
          setPending((prev) => {
            // A second request while one is open cannot be answered by the same dialog. Declining
            // the older one is the safe direction: it is the call the user is no longer looking at.
            prev?.resolve(false);
            return { req, resolve };
          });
        })
    );
    return () => setSafeModeConfirmer(null);
  }, []);

  if (!pending) return null;

  const { req, resolve } = pending;
  const answer = (ok: boolean) => {
    resolve(ok);
    setPending(null);
  };

  // Dynamic keys are not allowed (see i18n notes in CLAUDE.md), so a switch over the union.
  const unsafeLabel = (kind: UnsafeStatementKind): string => {
    switch (kind) {
      case 'deleteNoWhere':
        return t('sqlEditor.unsafeKindDeleteNoWhere');
      case 'updateNoWhere':
        return t('sqlEditor.unsafeKindUpdateNoWhere');
      case 'dropTable':
        return t('sqlEditor.unsafeKindDropTable');
      case 'truncate':
        return t('sqlEditor.unsafeKindTruncate');
    }
  };

  const counts = Object.entries(req.sql?.counts ?? {}).sort((a, b) => b[1] - a[1]);
  const hidden = (req.sql?.total ?? 0) - (req.sql?.preview.length ?? 0);

  // `commit_changes` tells the user nothing — it is a Rust function name. Grouped by WHAT the command
  // does rather than translating each name: five sentences cover all ~40 writing commands, while
  // per-name translation is ~40 strings × 3 languages to remember on every new command. The command
  // name is still shown right below, so this sentence need not be exact — it only has to answer "what
  // is this about to do".
  const kind = ((): 'save' | 'destructive' | 'bulk' | 'schema' | 'redis' | 'other' => {
    const c = req.command;
    if (c === 'commit_changes') return 'save';
    if (c.startsWith('drop_') || c === 'truncate_table' || c === 'redis_flush_db' || c.startsWith('redis_delete_')) {
      return 'destructive';
    }
    if (c.startsWith('import_') || c === 'restore_backup' || c === 'generate_data' || c === 'redis_restore_keys') {
      return 'bulk';
    }
    if (c.startsWith('create_') || c.startsWith('alter_') || c.startsWith('rename_') || c.startsWith('save_')) {
      return 'schema';
    }
    if (c.startsWith('redis_')) return 'redis';
    return 'other';
  })();

  // Literal keys in the switch, never interpolated — see the i18n notes in CLAUDE.md.
  const actionLabel = (): string => {
    switch (kind) {
      case 'save':
        return t('safeMode.actionSave');
      case 'destructive':
        return t('safeMode.actionDestructive');
      case 'bulk':
        return t('safeMode.actionBulk');
      case 'schema':
        return t('safeMode.actionSchema');
      case 'redis':
        return t('safeMode.actionRedis');
      case 'other':
        return t('safeMode.confirmCommandIntro');
    }
  };

  // Commands that delete data or objects take the danger styling `ConfirmDialog` uses: the confirm
  // button is the last thing standing in the way, so it must not look like an ordinary "OK".
  const danger = kind === 'destructive';
  const accent = danger ? 'var(--st-danger, #e5484d)' : 'var(--win-accent)';

  // The confirm button's label follows what is about to happen. "Run" for a save is vague exactly
  // where clarity matters most: this button is the answer, so it has to echo the question's own verb.
  const confirmLabel = (): string => {
    switch (kind) {
      case 'save':
        return t('safeMode.confirmSave');
      case 'destructive':
        return t('safeMode.confirmDelete');
      default:
        return t('safeMode.confirmRun');
    }
  };

  const c = req.target?.changes;
  // Only the kinds that are actually present, in "insert → update → delete" order — a line reading
  // "0 inserted, 0 deleted" makes the reader filter out the number worth reading.
  const changeParts = c
    ? [
        c.inserts > 0 ? t('safeMode.nInserts', { n: c.inserts }) : null,
        c.updates > 0 ? t('safeMode.nUpdates', { n: c.updates }) : null,
        c.deletes > 0 ? t('safeMode.nDeletes', { n: c.deletes }) : null,
      ].filter(Boolean)
    : [];

  // The active Safe Mode level, so the dialog answers "why am I being asked" itself — and says where to turn it off.
  const modeName = req.mode === 'all' ? t('safeMode.modeAll') : t('safeMode.modeWrites');

  return (
    <Modal
      title={t('safeMode.confirmTitle')}
      icon={
        danger
          ? <AlertTriangle size={14} style={{ color: accent, flexShrink: 0 }} />
          : <ShieldAlert size={14} style={{ color: accent, flexShrink: 0 }} />
      }
      onClose={() => answer(false)}
      // The dialog is wide in order to hold the SQL preview. The branch without SQL has one sentence
      // and one command name, so 620px there is a near-empty rectangle — it drops to 420px, as
      // `ConfirmDialog` uses.
      width={req.sql ? '620px' : '420px'}
      maxWidth="92%"
      zIndex={100000}
    >
      <ModalBody>
        <div
          style={{
            fontSize: '12.5px',
            // In the SQL branch this sentence introduces the block below it, so it is secondary text.
            // In the command branch it IS the main content ("this is about to write to the database"),
            // so it does not take the secondary colour.
            color: req.sql ? 'var(--win-text-secondary)' : 'var(--win-text-primary)',
            lineHeight: 1.6,
          }}
        >
          {req.sql ? t('safeMode.confirmSqlIntro') : actionLabel()}
        </div>

        {/* The action's description, when whoever called `runApproved()` supplied one. It sits ABOVE
            the command name rather than replacing it: the command name is still the most precise
            label, while this line is what answers "approve what" for an action asked about once. */}
        {req.detail && (
          <div style={{ fontSize: '12.5px', color: 'var(--win-text-primary)', lineHeight: 1.6 }}>
            {req.detail}
          </div>
        )}

        {/* The specific context: which table, how many changes, of what kind. This is the part that
            answers the user's real question — "Save 3 changes to table film (2 updates, 1 delete)" —
            instead of a generic sentence plus a Rust function name. Every number here comes from the
            command's own arguments. */}
        {!req.sql && (req.target?.name || changeParts.length > 0 || req.target?.count) && (
          <div style={{ fontSize: '12.5px', color: 'var(--win-text-primary)', lineHeight: 1.6 }}>
            {req.target?.name && (
              <div>
                {t('safeMode.targetTable')} <span className="smg-target">{req.target.name}</span>
              </div>
            )}
            {changeParts.length > 0 && (
              <div style={{ color: 'var(--win-text-secondary)' }}>{changeParts.join(' · ')}</div>
            )}
            {!changeParts.length && !!req.target?.count && (
              <div style={{ color: 'var(--win-text-secondary)' }}>
                {t('safeMode.nItems', { n: req.target.count })}
              </div>
            )}
          </div>
        )}

        {/* The command name and the active level, small and last: the command name is the most precise
            label when cross-checking a log or `COMMAND_KINDS`, but it is what the user needs LAST, not
            the only thing they see. The level line answers "why am I being asked" and points at where
            to turn it off. */}
        {!req.sql && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span className="smg-cmd">{req.command}</span>
            <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
              {t('safeMode.becauseMode', { mode: modeName })}
            </span>
          </div>
        )}

        {req.sql && counts.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {counts.map(([head, n]) => (
              <span
                key={head}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '3px 10px',
                  borderRadius: '999px',
                  fontSize: '11px',
                  fontWeight: 600,
                  fontFamily: 'var(--win-font-mono, monospace)',
                  color: 'var(--win-text-secondary)',
                  background: 'var(--win-bg-window)',
                  border: '1px solid var(--win-border)',
                }}
              >
                {head}
                {/* Not a translatable string — a multiplication sign in front of a count. */}
                <span style={{ opacity: 0.7 }}>{`×${n}`}</span>
              </span>
            ))}
          </div>
        )}

        {req.sql && req.sql.unsafe.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: '10px',
              padding: '10px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              lineHeight: 1.55,
              color: 'var(--win-status-deleted-border)',
              background: 'var(--win-status-deleted)',
              border: '1px solid var(--win-status-deleted-border)',
            }}
          >
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '2px' }} />
            <div>
              {Array.from(new Set(req.sql.unsafe.map((u) => u.kind))).map((unsafeKind) => (
                <div key={unsafeKind}>{unsafeLabel(unsafeKind)}</div>
              ))}
            </div>
          </div>
        )}

        {req.sql && (
          <pre
            style={{
              margin: 0,
              maxHeight: '280px',
              overflow: 'auto',
              padding: '12px 14px',
              background: 'var(--win-bg-tab-bar)',
              border: '1px solid var(--win-border)',
              borderRadius: '6px',
              fontFamily: 'var(--win-font-mono, monospace)',
              fontSize: '11.5px',
              lineHeight: 1.55,
              color: 'var(--win-text-primary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {req.sql.preview.join(';\n')}
            {hidden > 0 && `\n\n${t('safeMode.moreStatements', { n: hidden, cap: STATEMENT_PREVIEW_CAP })}`}
          </pre>
        )}
      </ModalBody>

      <ModalFooter>
        <button className="btn btn-secondary" onClick={() => answer(false)}>
          {t('common.cancel')}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => answer(true)}
          // Danger styling for deleting commands, as `ConfirmDialog` does: this button is the last thing
          // standing in the way, so it should not look like an ordinary "OK".
          style={danger ? { background: accent, borderColor: accent } : undefined}
        >
          {confirmLabel()}
        </button>
      </ModalFooter>
    </Modal>
  );
};
