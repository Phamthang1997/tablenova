import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Ban, Bell, CheckCircle2, FolderOpen, Loader2 } from 'lucide-react';
import {
  activeJobs,
  cancelJob,
  clearFinishedJobs,
  listJobs,
  subscribeJobs,
  type JobRecord,
} from '../utils/jobs';
import { CLOSE_PRIORITY_JOBS, forceClose, registerCloseBlocker } from '../utils/closeGuard';
import { openInFileManager } from '../utils/fileSave';
import { ProgressBar } from './ProgressBar';
import { Modal, ModalBody, ModalFooter } from './Modal';

/** Cùng chiều rộng với `.jobs-pop` trong index.css — dùng để neo popover cho khỏi tràn màn hình. */
const POP_WIDTH = 380;

/**
 * Việc chạy nền: một nút **chuông** trên thanh tiêu đề, danh sách nằm trong popover **neo ngay dưới
 * nút** — không phải hộp thoại giữa màn hình. Một việc đang chạy nền là thông báo, không phải một
 * thao tác cần cả màn hình; và mở nó ra không được che thứ người dùng đang làm.
 *
 * Cách neo (`top`/`left` + portal + backdrop) lấy đúng theo `SafeModeControl`, popover kia của thanh
 * tiêu đề: `right` + `position: fixed` làm lớp blur bị lệch khỏi nội dung của chính nó.
 *
 * Component này **không** giữ tiến độ: nó đọc từ `utils/jobs.ts` qua `useSyncExternalStore`, nên
 * đóng popover (hay unmount cả nút) không làm mất job. Đó là toàn bộ mục đích của module kia.
 */
export const JobsTray: React.FC = () => {
  const { t } = useTranslation();
  const jobs = useSyncExternalStore(subscribeJobs, listJobs);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [askOnClose, setAskOnClose] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const active = jobs.filter((j) => j.state === 'running' || j.state === 'queued');
  const finished = jobs.filter((j) => j.state !== 'running' && j.state !== 'queued');

  // Đóng app khi job đang chạy = một bản restore nạp được một nửa, không resume được. Hỏi trước.
  // Blocker chứ không phải listener riêng — xem `closeGuard.ts`.
  useEffect(() => registerCloseBlocker(CLOSE_PRIORITY_JOBS, () => {
    if (activeJobs().length === 0) return false;
    setAskOnClose(true);
    return true;
  }), []);

  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAnchor(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [anchor]);

  // Chưa từng có job nào thì không chiếm chỗ trên thanh tiêu đề.
  if (jobs.length === 0) return null;

  const failed = finished.some((j) => j.state === 'error');
  const capsuleTitle = active.length
    ? t('jobs.trayRunning', { n: active.length })
    : failed
      ? t('jobs.trayFailed')
      : t('jobs.trayIdle');

  // Neo phải theo nút rồi kẹp lại, để nút sát mép nào cũng thấy trọn popover.
  const open = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const maxLeft = Math.max(10, window.innerWidth - POP_WIDTH - 10);
    setAnchor({ top: rect.bottom + 6, left: Math.min(maxLeft, Math.max(10, rect.right - POP_WIDTH)) });
  };

  return (
    <>
      {/* Bọc `.tb-capsule` như `TxControl`: lớp đó giữ chiều cao 34px và canh giữa của thanh tiêu
          đề, `.tb-capsule-btn` một mình chỉ có dáng của cái nút. */}
      <div className="tb-capsule" style={{ flexShrink: 0 }}>
        <button
          ref={btnRef}
          className={`tb-capsule-btn ${active.length ? 'is-active-accent' : ''} ${!active.length && failed ? 'is-active-warn' : ''}`}
          onClick={() => (anchor ? setAnchor(null) : open())}
          title={capsuleTitle}
          aria-label={capsuleTitle}
        >
          {/* Chuông là biểu tượng của thông báo; số việc đang chạy là cái badge cạnh nó — cùng
              cách đọc với mọi khay thông báo, không phải một icon đổi hình theo trạng thái. */}
          <Bell size={13} />
          {active.length > 0 && <span className="jobs-badge">{active.length}</span>}
        </button>
      </div>

      {anchor &&
        createPortal(
          <>
            {/* `.jobs-backdrop`/`.jobs-pop` dùng CHUNG rule với `.sm-backdrop`/`.sm-pop` của Safe
                Mode (một selector ghép trong index.css, không phải bản sao) — dáng popover của thanh
                tiêu đề sửa một chỗ là cả hai đổi theo. `.sm-pop-title` là hàng tiêu đề của dáng đó. */}
            <div className="jobs-backdrop" onClick={() => setAnchor(null)} />
            {/* Chỉ `top`/`left` là inline — đó là giá trị đo lúc render; dáng nằm ở .jobs-pop. */}
            <div className="jobs-pop" style={{ top: anchor.top, left: anchor.left }} role="dialog">
              <div className="jobs-pop-head">
                <div className="sm-pop-title">{t('jobs.panelTitle')}</div>
                <button
                  type="button"
                  className="jobs-pop-clear"
                  disabled={finished.length === 0}
                  onClick={clearFinishedJobs}
                >
                  {t('jobs.clearFinished')}
                </button>
              </div>
              <div className="jobs-list">
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </div>
            </div>
          </>,
          document.body,
        )}

      {askOnClose && (
        <Modal title={t('jobs.closeTitle')} onClose={() => setAskOnClose(false)} zIndex={100001} width="440px">
          <ModalBody>
            <div style={{ fontSize: '12px', lineHeight: 1.5 }}>
              {t('jobs.closeMessage', { n: activeJobs().length })}
            </div>
          </ModalBody>
          <ModalFooter>
            <button type="button" className="btn btn-secondary" onClick={() => setAskOnClose(false)}>
              {t('jobs.keepOpen')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setAskOnClose(false);
                // Đóng thẳng: đi qua `close()` lần nữa là hỏi lại đúng câu vừa trả lời.
                forceClose();
              }}
            >
              {t('jobs.closeAnyway')}
            </button>
          </ModalFooter>
        </Modal>
      )}
    </>
  );
};

const STATE_KEY: Record<JobRecord['state'], string> = {
  queued: 'jobs.stateQueued',
  running: 'jobs.stateRunning',
  done: 'jobs.stateDone',
  error: 'jobs.stateError',
  cancelled: 'jobs.stateCancelled',
};

const JobRow: React.FC<{ job: JobRecord }> = ({ job }) => {
  const { t } = useTranslation();
  const running = job.state === 'running';
  const queued = job.state === 'queued';

  // Nhãn trạng thái là key literal tra trong bảng trên, không phải key ghép chuỗi — `t()` được
  // kiểm kiểu theo cây key của `en.ts`.
  const stateLabel = t(STATE_KEY[job.state] as 'jobs.stateQueued');

  const icon = running ? (
    <Loader2 size={13} className="loading-spinner" />
  ) : job.state === 'done' ? (
    <CheckCircle2 size={13} className="jobs-icon-ok" />
  ) : job.state === 'error' ? (
    <AlertTriangle size={13} className="jobs-icon-error" />
  ) : job.state === 'cancelled' ? (
    <Ban size={13} className="jobs-icon-muted" />
  ) : (
    <Bell size={13} className="jobs-icon-muted" />
  );

  return (
    <div className="jobs-row">
      <div className="jobs-row-icon">{icon}</div>
      <div className="jobs-row-body">
        <div className="jobs-row-head">
          <span className="jobs-row-title">{job.title}</span>
          <span className="jobs-row-state">
            {job.cancelRequested && running ? t('jobs.cancelling') : stateLabel}
          </span>
        </div>

        {/* Đang chờ vì có job khác đang ghi vào cùng database — nói ra, đừng để nó im ở 0%. */}
        {queued && <div className="jobs-row-note">{t('jobs.waitingTurn')}</div>}

        {running && job.progress && (
          <ProgressBar progress={{ ...job.progress, label: job.progress.label || job.title }} />
        )}

        {job.error && <div className="jobs-row-error">{job.error}</div>}

        {job.result && (
          <div className="jobs-row-result">
            {job.result.message}
            {job.result.warning && <div className="jobs-row-warn">{job.result.warning}</div>}
          </div>
        )}
      </div>

      <div className="jobs-row-actions">
        {(running || queued) && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={job.cancelRequested}
            onClick={() => cancelJob(job.id)}
          >
            {t('jobs.cancel')}
          </button>
        )}
        {job.result?.dir && (
          <button
            type="button"
            className="btn btn-secondary"
            // Mở THƯ MỤC, không mở tệp: `openInFileManager` gọi `open_url`, nên đưa đường dẫn tệp
            // vào là hệ điều hành mở tệp .sql bằng ứng dụng mặc định — không phải điều người ta
            // muốn khi bấm "mở thư mục". Đường dẫn tệp đi vào tooltip.
            title={job.result.path || job.result.dir}
            onClick={() => void openInFileManager(job.result!.dir!)}
          >
            <FolderOpen size={12} />
          </button>
        )}
      </div>
    </div>
  );
};
