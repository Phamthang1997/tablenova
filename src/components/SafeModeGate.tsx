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

  // `commit_changes` not nói is gì with user — đó is tên hàm at Rust. Nhóm theo VIỆC mà
  // lệnh ism, chứ not dịch fromng tên: gom nhóm thì năm câu phủ hết ~40 lệnh write, còn dịch fromng tên
  // is ~40 string × 3 ngôn ngữ must nhớ cập nhật mỗi lần add một command. Tên lệnh vẫn hiện ngay
  // under, nên câu này not cần chính xác tuyệt đối — nó chỉ cần trả lời "cái này sắp ism gì".
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

  // key literal in switch, not nội suy — xem write chú i18n at CLAUDE.md.
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

  // Lệnh delete dữ liệu/đối tượng dùng tông danh giống `ConfirmDialog`: nút confirm is chỗ cuối cùng
  // còn cản is, nên nó must trông khác with một nút "OK" bình thường.
  const danger = kind === 'destructive';
  const accent = danger ? 'var(--st-danger, #e5484d)' : 'var(--win-accent)';

  // Nhãn nút confirm theo việc sắp ism. "Run" for một lần save is mơ hồ đúng chỗ đáng lẽ must rõ
  // nhất: nút này is câu trả lời, nên nó must nhắc lại chính động from of câu hỏi.
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
  // Chỉ những loại thật sự có, and theo thứ tự "add → edit → delete" — một row "0 add, 0 delete" bắt
  // người read filter lấy con số đáng read.
  const changeParts = c
    ? [
        c.inserts > 0 ? t('safeMode.nInserts', { n: c.inserts }) : null,
        c.updates > 0 ? t('safeMode.nUpdates', { n: c.updates }) : null,
        c.deletes > 0 ? t('safeMode.nDeletes', { n: c.deletes }) : null,
      ].filter(Boolean)
    : [];

  // Mức Safe Mode currently bật, to hộp thoại tự trả lời "sao lại hỏi tôi" — and nói luôn chỗ tắt.
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
      // Hộp thoại rộng is to chứa khối SQL preview. Nhánh not có SQL chỉ có một câu and một tên
      // lệnh, nên 620px at đó is một ô chữ nhật gần như trống — về đúng 420px như `ConfirmDialog`.
      width={req.sql ? '620px' : '420px'}
      maxWidth="92%"
      zIndex={100000}
    >
      <ModalBody>
        <div
          style={{
            fontSize: '12.5px',
            // Nhánh SQL: câu này is dẫn nhập for khối SQL bên under nên nó is chữ phụ. Nhánh command:
            // nó is nội dung chính ("việc này sắp write ando DB"), nên not to màu chữ phụ.
            color: req.sql ? 'var(--win-text-secondary)' : 'var(--win-text-primary)',
            lineHeight: 1.6,
          }}
        >
          {req.sql ? t('safeMode.confirmSqlIntro') : actionLabel()}
        </div>

        {/* Câu mô tả of hành động, when chỗ gọi `runApproved()` có send. Đứng on tên command chứ
            not thay nó: tên command vẫn is nhãn chính xác nhất, còn row này is thứ trả lời is
            câu "duyệt cái gì" for một hành động chỉ is hỏi một lần. */}
        {req.detail && (
          <div style={{ fontSize: '12.5px', color: 'var(--win-text-primary)', lineHeight: 1.6 }}>
            {req.detail}
          </div>
        )}

        {/* Ngữ cảnh cụ thể: table nào, mấy change, loại gì. Đây is phần trả lời is câu hỏi thật
            of user — "save 3 change ando table film (2 edit, 1 delete)" — thay for một câu chung
            chung cộng một tên hàm Rust. Mọi con số at đây lấy from chính tham số of lệnh. */}
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

        {/* Tên lệnh + mức currently bật, cỡ nhỏ, cuối cùng: tên lệnh is nhãn chính xác nhất when cần đối
            chiếu with log hay `COMMAND_KINDS`, nhưng nó is thứ user cần SAU CÙNG, not must
            thứ unique họ thấy. row mức trả lời "sao lại hỏi tôi" and chỉ luôn chỗ tắt. */}
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
        <button
          className="btn btn-primary"
          onClick={() => answer(true)}
          // Tông danh for lệnh delete, giống `ConfirmDialog`: nút này is chỗ cuối cùng còn cản is,
          // nên nó not nên trông giống một nút "OK" thường.
          style={danger ? { background: accent, borderColor: accent } : undefined}
        >
          {confirmLabel()}
        </button>
      </ModalFooter>
    </Modal>
  );
};
