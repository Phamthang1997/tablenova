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

/** Cùng width with `.jobs-pop` in index.css — dùng to neo popover for khỏi tràn màn hình. */
const POP_WIDTH = 380;

/**
 * Việc run nền: một nút **chuông** on title bar, danh sách nằm in popover **neo ngay under
 * nút** — not must hộp thoại giữa màn hình. Một việc currently run nền is thông báo, not must một
 * thao tác cần cả màn hình; and open nó ra not is che thứ user currently ism.
 *
 * Cách neo (`top`/`left` + portal + backdrop) lấy đúng theo `SafeModeControl`, popover kia of thanh
 * tiêu đề: `right` + `position: fixed` ism lớp blur is lệch khỏi nội dung of chính nó.
 *
 * Component này **not** giữ tiến độ: nó read from `utils/jobs.ts` qua `useSyncExternalStore`, nên
 * close popover (hay unmount cả nút) not ism mất job. Đó is toàn bộ mục đích of module kia.
 */
export const JobsTray: React.FC = () => {
  const { t } = useTranslation();
  const jobs = useSyncExternalStore(subscribeJobs, listJobs);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [askOnClose, setAskOnClose] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const active = jobs.filter((j) => j.state === 'running' || j.state === 'queued');
  const finished = jobs.filter((j) => j.state !== 'running' && j.state !== 'queued');

  // close app when job currently run = một bản restore load is một nửa, not resume is. Hỏi trước.
  // Blocker chứ not must listener riêng — xem `closeGuard.ts`.
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

  // Chưa fromng có job nào thì not chiếm chỗ on title bar.
  if (jobs.length === 0) return null;

  const failed = finished.some((j) => j.state === 'error');
  const capsuleTitle = active.length
    ? t('jobs.trayRunning', { n: active.length })
    : failed
      ? t('jobs.trayFailed')
      : t('jobs.trayIdle');

  // Neo must theo nút rồi kẹp lại, to nút sát mép nào cũng thấy trọn popover.
  const open = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const maxLeft = Math.max(10, window.innerWidth - POP_WIDTH - 10);
    setAnchor({ top: rect.bottom + 6, left: Math.min(maxLeft, Math.max(10, rect.right - POP_WIDTH)) });
  };

  return (
    <>
      {/* Bọc `.tb-capsule` như `TxControl`: lớp đó giữ height 34px and canh giữa of thanh tiêu
          đề, `.tb-capsule-btn` một mình chỉ có dáng of cái nút. */}
      <div className="tb-capsule" style={{ flexShrink: 0 }}>
        <button
          ref={btnRef}
          className={`tb-capsule-btn ${active.length ? 'is-active-accent' : ''} ${!active.length && failed ? 'is-active-warn' : ''}`}
          onClick={() => (anchor ? setAnchor(null) : open())}
          title={capsuleTitle}
          aria-label={capsuleTitle}
        >
          {/* Chuông is biểu tượng of thông báo; số việc currently run is cái badge cạnh nó — cùng
              cách read with mọi khay thông báo, not must một icon đổi hình theo status. */}
          <Bell size={13} />
          {active.length > 0 && <span className="jobs-badge">{active.length}</span>}
        </button>
      </div>

      {anchor &&
        createPortal(
          <>
            {/* `.jobs-backdrop`/`.jobs-pop` dùng CHUNG rule with `.sm-backdrop`/`.sm-pop` of Safe
                Mode (một selector ghép in index.css, not must bản sao) — dáng popover of thanh
                tiêu đề edit một chỗ is cả hai đổi theo. `.sm-pop-title` is row tiêu đề of dáng đó. */}
            <div className="jobs-backdrop" onClick={() => setAnchor(null)} />
            {/* Chỉ `top`/`left` is inline — đó is giá trị đo lúc render; dáng nằm at .jobs-pop. */}
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
                // close thẳng: đi qua `close()` lần nữa is hỏi lại đúng câu vừa trả lời.
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

  // Nhãn status is key literal tra in table on, not must key ghép string — `t()` is
  // kiểm kiểu theo cây key of `en.ts`.
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

        {/* currently wait vì có job khác currently write ando cùng database — nói ra, đừng to nó im at 0%. */}
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
            // open THƯ MỤC, not open tệp: `openInFileManager` gọi `open_url`, nên đưa đường dẫn tệp
            // ando is hệ điều hành open tệp .sql bằng ứng dụng default — not must điều người ta
            // muốn when bấm "open thư mục". Đường dẫn tệp đi ando tooltip.
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
