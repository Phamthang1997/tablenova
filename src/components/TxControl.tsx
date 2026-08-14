import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AlertTriangle, Undo2 } from 'lucide-react';
import { dbHelper, TX_EVENT, TX_ISOLATION_LEVELS, type TxStatus } from '../utils/dbHelper';
import { Modal, ModalBody, ModalFooter } from './Modal';

interface TxControlProps {
  /** 'sqlite' | 'postgres' | 'mysql' — quyết định danh sách mức cô lập hiển thị. */
  dbType: string;
  /** Ẩn hoàn toàn khi chưa kết nối. */
  connected: boolean;
}

/**
 * Điều khiển transaction thủ công: MỘT nút trên thanh tiêu đề, mọi thao tác nằm trong hộp thoại
 * "thay đổi đang chờ".
 *
 * Transaction ở đây thuộc về **kết nối**, không thuộc về tab — `DatabaseManager` giữ đúng một
 * connection cho cả app, nên nói rằng hai tab có hai transaction là nói dối. Vì vậy nút nằm ở thanh
 * tiêu đề chứ không ở toolbar từng tab.
 *
 * Frontend KHÔNG tự suy ra trạng thái: mọi thứ hiển thị ở đây đến từ sự kiện `tx-state-changed`
 * do Rust phát sau mỗi câu lệnh — kể cả câu người dùng tự gõ `COMMIT` trong SQL Editor và câu DDL
 * mà MySQL tự commit. Xem `src-tauri/src/tx_session.rs`.
 */
export const TxControl: React.FC<TxControlProps> = ({ dbType, connected }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TxStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spName, setSpName] = useState('');
  // Đồng hồ chỉ để vẽ lại phần "đã mở bao lâu"; `sinceMs` trong status là ảnh chụp lúc backend gửi.
  const [tick, setTick] = useState(0);
  const [askOnClose, setAskOnClose] = useState(false);
  const openedAtRef = useRef<number>(0);
  // Handler đóng cửa sổ chỉ đăng ký một lần; đọc trạng thái qua ref để không phải gỡ/gắn lại
  // mỗi khi bộ đếm câu lệnh thay đổi.
  const statusRef = useRef<TxStatus | null>(null);
  statusRef.current = status;

  const refresh = useCallback(async () => {
    try {
      setStatus(await dbHelper.txStatus());
    } catch {
      /* chưa kết nối -> giữ nguyên */
    }
  }, []);

  useEffect(() => {
    if (!connected) {
      setStatus(null);
      setOpen(false);
      return;
    }
    void refresh();
    const un = listen<TxStatus>(TX_EVENT, (e) => setStatus(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, [connected, refresh]);

  // Mốc thời gian tính ở client: backend chỉ gửi `sinceMs` tại thời điểm phát sự kiện, còn
  // transaction có thể nằm im hàng phút mà không có sự kiện nào.
  useEffect(() => {
    if (!status?.open) return;
    openedAtRef.current = Date.now() - status.sinceMs;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [status?.open, status?.sinceMs]);

  // Đóng app khi còn thay đổi chưa commit = mất trắng. Chặn ở `onCloseRequested` chứ không ở nút
  // × của TitleBar: Alt+F4 và nút đóng của hệ điều hành không đi qua nút đó.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested((event) => {
      const s = statusRef.current;
      if (!s?.open || s.statements === 0) return;
      event.preventDefault();
      setAskOnClose(true);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  if (!connected || !status) return null;

  const elapsedMs = status.open ? Date.now() - openedAtRef.current : 0;
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const elapsed =
    totalSec < 60
      ? t('tx.elapsedSec', { n: totalSec })
      : t('tx.elapsedMin', { n: Math.floor(totalSec / 60), b: totalSec % 60 });
  // Mốc mềm 5 phút: transaction dài giữ khoá và làm phình undo log/WAL.
  const isLong = status.open && totalSec >= 300;
  const levels = TX_ISOLATION_LEVELS[dbType] || [];
  const isSqlite = dbType === 'sqlite';

  // Nút là một CÔNG TẮC, không phải dropdown: hộp thoại chỉ mở khi có thứ để quyết định.
  //   Tự động            -> bấm: chuyển sang thủ công
  //   Thủ công, chưa có gì -> bấm: chuyển về tự động
  //   Thủ công, N câu chờ  -> bấm: mở hộp thoại (không đổi chế độ — backend cũng chặn đổi khi còn
  //                          thay đổi chưa commit, nên đổi chế độ ở đây chỉ tổ báo lỗi)
  const hasPending = status.statements > 0;
  const summaryTitle = hasPending
    ? `${t('tx.clickToReview', { n: status.statements })} · ${
        status.aborted ? t('tx.aborted') : t('tx.longOpen', { n: elapsed })
      }`
    : status.autocommit
      ? `${t('tx.clickToManual')} — ${t('tx.manualDesc')}`
      : `${t('tx.clickToAuto')} — ${t('tx.autoDesc')}`;

  const handleButton = () => {
    setError(null);
    if (hasPending) {
      setOpen(true);
      return;
    }
    void run(() => dbHelper.txSetAutocommit(!status.autocommit));
  };

  /**
   * `refetch` is for the operations that change the rows the user is looking at — Commit, Discard,
   * `ROLLBACK TO`. Without it the grid keeps showing the value that was just rolled back, which
   * reads as "Discard did not roll anything back" even though the backend did. `database-restored`
   * is the event `DataGrid` and `Sidebar` already listen to, so this needs no new channel.
   *
   * Mode / isolation / savepoint do NOT refetch: they change no row, and reloading the grid there
   * would be a round trip for nothing.
   */
  const run = async (
    fn: () => Promise<TxStatus>,
    closeAfter = false,
    refetch = false,
  ) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
      if (refetch) window.dispatchEvent(new CustomEvent('database-restored'));
      if (closeAfter) setOpen(false);
    } catch (err) {
      // Message đã được dịch ở biên dbHelper (backendErrors.ts).
      setError(String(err));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  // `pendingSql` có thể vắng mặt nếu backend đang chạy là bản CŨ hơn cửa sổ này (tauri dev giữ
  // nguyên binary cuối cùng build được khi Rust lỗi biên dịch). Nói thẳng ra thay vì hiện một ô
  // trống không giải thích được — và đọc phòng thủ để không nổ TypeError giữa lúc render.
  const pendingList = Array.isArray(status.pendingSql) ? status.pendingSql : null;

  // Gom các câu giống hệt nhau thành một mục, giữ thứ tự lần chạy ĐẦU tiên và kèm số lần chạy.
  //
  // Số lần phải hiện ra: bốn lần `UPDATE … SET first_name = 'X'` cho cùng kết quả với một lần, nhưng
  // bốn lần `SET n = n + 1` thì không — và nhìn text thì không phân biệt được hai trường hợp. Server
  // đã thực thi đủ bốn câu và Rollback đang gỡ cả bốn, nên bỏ hẳn con số là nói sai với người dùng.
  const groupedPending = (pendingList ?? []).reduce<{ sql: string; times: number }[]>((acc, sql) => {
    const hit = acc.find((g) => g.sql === sql);
    if (hit) hit.times += 1;
    else acc.push({ sql, times: 1 });
    return acc;
  }, []);

  return (
    <>
      {/* MỘT nút duy nhất trên thanh tiêu đề. Bản trước bày mode + bộ đếm + Commit + Rollback thành
          bốn thứ rời nhau, chiếm ~330px và bóp capsule trạng thái ở giữa (flex:1) xuống còn một
          vòng tròn. Mọi thao tác nằm trong hộp thoại.

          `tb-capsule-btn` giữ nguyên dáng mặc định của thanh — không override màu/độ đậm/gap ở đây;
          khoảng cách đặt trên các phần tử con. */}
      <div className="tb-capsule" style={{ flexShrink: 0 }}>
        <button
          type="button"
          className="tb-capsule-btn"
          onClick={handleButton}
          disabled={busy}
          title={summaryTitle}
          // `tick` chỉ để buộc render lại mỗi giây cho tooltip thời gian mở.
          data-tick={tick}
        >
          {hasPending && (
            <span
              aria-hidden
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                marginRight: '6px',
                background: status.aborted ? 'var(--win-danger, #ef4444)' : '#f59e0b',
                flexShrink: 0,
              }}
            />
          )}
          <span>{status.autocommit ? t('tx.autoShort') : t('tx.manualShort')}</span>
          {hasPending && <span style={{ marginLeft: '5px' }}>{`· ${status.statements}`}</span>}
        </button>
      </div>

      {open && (
        <Modal
          title={t('tx.pendingTitle')}
          onClose={busy ? undefined : () => setOpen(false)}
          closeDisabled={busy}
          width="760px"
          maxWidth="92%"
          maxHeight="82vh"
          zIndex={99999}
        >
          <ModalBody style={{ padding: 0, gap: 0, flex: 1, minHeight: 0 }}>
            {/* Hàng thiết lập: chế độ + mức cô lập. Thiết kế gốc của hộp thoại chỉ có phần SQL và
                hai nút, nhưng công tắc auto-commit và mức cô lập phải có chỗ nào đó — để ở đây thì
                chúng nằm cùng nơi với thứ chúng chi phối. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
                padding: '10px 14px',
                borderBottom: '1px solid var(--win-border)',
              }}
            >
              <div style={{ display: 'flex', gap: '6px' }}>
                {[true, false].map((auto) => (
                  <button
                    key={String(auto)}
                    type="button"
                    className={`btn ${status.autocommit === auto ? 'btn-primary' : 'btn-secondary'}`}
                    // Quay về tự động khi còn thay đổi chưa commit thì backend từ chối — chặn ở đây
                    // và nói lý do, thay vì để người dùng bấm rồi nhận một dòng lỗi.
                    disabled={busy || (auto && hasPending)}
                    title={auto && hasPending ? t('tx.autoBlocked') : auto ? t('tx.autoDesc') : t('tx.manualDesc')}
                    onClick={() => void run(() => dbHelper.txSetAutocommit(auto))}
                  >
                    {auto ? t('tx.auto') : t('tx.manual')}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
                <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                  {isSqlite ? t('tx.lockMode') : t('tx.isolation')}
                </span>
                <select
                  className="input"
                  style={{ width: '190px' }}
                  value={status.isolation || ''}
                  disabled={busy}
                  title={t('tx.isolationHint')}
                  onChange={(e) => void run(() => dbHelper.txSetIsolation(e.target.value || null))}
                >
                  <option value="">{t('tx.isolationDefault')}</option>
                  {levels.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                {!isSqlite && (
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px' }}
                    title={t('tx.readOnlyHint')}
                  >
                    <input
                      type="checkbox"
                      checked={status.readOnly}
                      disabled={busy}
                      onChange={(e) => void run(() => dbHelper.txSetIsolation(status.isolation, e.target.checked))}
                    />
                    <span>{t('tx.readOnly')}</span>
                  </label>
                )}
              </div>
            </div>

            {/* Các câu đang chờ. Dùng <pre> đơn sắc chứ không phải Monaco: hộp thoại xem trước SQL
                của DataGrid (`commitPreview`) đã làm đúng như vậy, và một khung Monaco dựng trong
                portal của Modal có quá nhiều cách hỏng lặng lẽ (đo kích thước lúc mount, theme
                chưa kịp định nghĩa) — hỏng kiểu đó thì người dùng chỉ thấy một ô trắng. */}
            <div
              style={{
                flex: 1,
                minHeight: '260px',
                overflow: 'auto',
                padding: '12px 14px',
                background: 'var(--win-bg-window)',
                fontFamily: 'var(--win-font-mono)',
                fontSize: '12px',
                color: 'var(--win-text-primary)',
              }}
            >
              {pendingList === null ? (
                <div style={{ color: 'var(--win-danger, #ef4444)', fontFamily: 'var(--win-font-sans)', lineHeight: 1.5 }}>
                  {t('tx.staleBackend')}
                </div>
              ) : pendingList.length === 0 ? (
                <div style={{ color: 'var(--win-text-secondary)', fontFamily: 'var(--win-font-sans)', lineHeight: 1.5 }}>
                  {status.open ? t('tx.pendingEmpty') : t(status.autocommit ? 'tx.autoDesc' : 'tx.manualDesc')}
                </div>
              ) : (
                groupedPending.map((g, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      gap: '10px',
                      padding: '4px 0 8px',
                      borderBottom: idx < groupedPending.length - 1 ? '1px dashed var(--win-border)' : 'none',
                      marginBottom: idx < groupedPending.length - 1 ? '8px' : 0,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        flexShrink: 0,
                        minWidth: '18px',
                        textAlign: 'right',
                        color: 'var(--win-text-disabled)',
                        userSelect: 'none',
                      }}
                    >
                      {idx + 1}
                    </span>
                    <pre style={{ margin: 0, flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {g.sql.trimEnd().endsWith(';') ? g.sql : `${g.sql};`}
                    </pre>
                    {g.times > 1 && (
                      <span
                        title={t('tx.ranTimes', { n: g.times })}
                        style={{
                          flexShrink: 0,
                          alignSelf: 'flex-start',
                          padding: '1px 7px',
                          borderRadius: '10px',
                          background: 'var(--win-bg-tab-bar)',
                          border: '1px solid var(--win-border)',
                          color: 'var(--win-text-secondary)',
                          fontSize: '11px',
                        }}
                      >
                        {`×${g.times}`}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Cảnh báo + savepoint: chỉ hiện khi có gì để nói, không chiếm chỗ thường trực. */}
            {(status.aborted || status.implicitCommit || isLong || status.sqlTruncated) && (
              <div
                style={{
                  padding: '10px 14px',
                  borderTop: '1px solid var(--win-border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  fontSize: '11.5px',
                  lineHeight: 1.45,
                }}
              >
                {status.aborted && (
                  <div style={{ display: 'flex', gap: '6px', color: 'var(--win-danger, #ef4444)' }}>
                    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
                    <span>{t('tx.abortedHint')}</span>
                  </div>
                )}
                {status.implicitCommit && (
                  <div style={{ color: 'var(--win-text-secondary)' }}>{t('tx.implicitNotice')}</div>
                )}
                {isLong && (
                  <div style={{ color: 'var(--win-danger, #ef4444)' }}>{t('tx.longOpen', { n: elapsed })}</div>
                )}
                {status.sqlTruncated && (
                  <div style={{ color: 'var(--win-text-secondary)' }}>
                    {t('tx.pendingTruncated', { n: status.pendingSql.length, b: status.statements })}
                  </div>
                )}
              </div>
            )}

            {status.open && (
              <div
                style={{
                  padding: '10px 14px',
                  borderTop: '1px solid var(--win-border)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                  {t('tx.savepoints')}
                </span>
                <input
                  type="text"
                  className="input"
                  style={{ width: '160px' }}
                  placeholder={t('tx.savepointPlaceholder')}
                  value={spName}
                  disabled={busy}
                  onChange={(e) => setSpName(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || !spName.trim()}
                  onClick={() =>
                    void run(async () => {
                      const s = await dbHelper.txSavepoint(spName.trim());
                      setSpName('');
                      return s;
                    })
                  }
                >
                  {t('tx.savepointAdd')}
                </button>
                {status.savepoints.map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    title={t('tx.savepointRollback')}
                    onClick={() => void run(() => dbHelper.txRollbackTo(sp), false, true)}
                  >
                    <Undo2 size={12} />
                    <span>{sp}</span>
                  </button>
                ))}
              </div>
            )}

            {error && (
              <div
                style={{
                  padding: '10px 14px',
                  borderTop: '1px solid var(--win-border)',
                  fontSize: '11.5px',
                  lineHeight: 1.45,
                  color: 'var(--win-danger, #ef4444)',
                }}
              >
                {error}
              </div>
            )}
          </ModalBody>

          <ModalFooter style={{ justifyContent: 'space-between' }}>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !status.open}
              onClick={() => void run(() => dbHelper.txRollback(), true, true)}
            >
              {t('tx.discard')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !status.open || status.aborted}
              onClick={() => void run(() => dbHelper.txCommit(), true, true)}
            >
              {t('tx.commit')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {askOnClose && (
        <Modal
          title={t('tx.closeTitle')}
          onClose={busy ? undefined : () => setAskOnClose(false)}
          closeDisabled={busy}
          zIndex={100001}
          width="440px"
        >
          <ModalBody>
            <div style={{ fontSize: '12px', lineHeight: 1.5 }}>
              {t('tx.closeMessage', { n: status.statements })}
            </div>
            {error && (
              <div style={{ fontSize: '11px', lineHeight: 1.45, color: 'var(--win-danger, #ef4444)' }}>{error}</div>
            )}
          </ModalBody>
          <ModalFooter>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setAskOnClose(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={async () => {
                await run(() => dbHelper.txRollback());
                // Transaction đã đóng -> lần close() này đi qua guard ở trên.
                void getCurrentWindow().close();
              }}
            >
              {t('tx.closeRollback')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                try {
                  setBusy(true);
                  setError(null);
                  setStatus(await dbHelper.txCommit());
                  void getCurrentWindow().close();
                } catch (err) {
                  // Commit lỗi thì KHÔNG đóng: đóng tiếp là vứt luôn thứ vừa báo lỗi.
                  setError(String(err));
                  void refresh();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('tx.closeCommit')}
            </button>
          </ModalFooter>
        </Modal>
      )}
    </>
  );
};
