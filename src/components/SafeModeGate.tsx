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

  return (
    <Modal
      title={t('safeMode.confirmTitle')}
      icon={<ShieldAlert size={14} style={{ color: 'var(--win-accent)', flexShrink: 0 }} />}
      onClose={() => answer(false)}
      width="620px"
      maxWidth="92%"
      zIndex={100000}
    >
      <ModalBody>
        <div style={{ fontSize: '12.5px', color: 'var(--win-text-secondary)', lineHeight: 1.6 }}>
          {req.sql ? t('safeMode.confirmSqlIntro') : t('safeMode.confirmCommandIntro')}
        </div>

        {!req.sql && (
          <div
            style={{
              fontFamily: 'var(--win-font-mono, monospace)',
              fontSize: '12px',
              color: 'var(--win-text-primary)',
              background: 'var(--win-bg-tab-bar)',
              border: '1px solid var(--win-border)',
              borderRadius: '6px',
              padding: '10px 12px',
            }}
          >
            {req.command}
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
              {Array.from(new Set(req.sql.unsafe.map((u) => u.kind))).map((kind) => (
                <div key={kind}>{unsafeLabel(kind)}</div>
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
        <button className="btn btn-primary" onClick={() => answer(true)}>
          {t('safeMode.confirmRun')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
