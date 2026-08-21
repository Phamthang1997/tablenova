import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Ban, CheckCircle2, FolderOpen, Loader2, ListChecks } from 'lucide-react';
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

/**
 * Việc chạy nền: MỘT nút trên thanh tiêu đề, danh sách nằm trong hộp thoại.
 *
 * Cùng lý do với `TxControl`: thanh tiêu đề không còn chỗ cho bốn thứ rời rạc, và một job đang chạy
 * thì thứ duy nhất cần thấy ngay là "có mấy cái đang chạy". Phần còn lại — tiến độ, huỷ, mở thư
 * mục, lỗi — mở ra khi cần.
 *
 * Component này **không** giữ tiến độ: nó đọc từ `utils/jobs.ts` qua `useSyncExternalStore`, nên
 * đóng hộp thoại (hay unmount cả nút) không làm mất job. Đó là toàn bộ mục đích của module kia.
 */
export const JobsTray: React.FC = () => {
  const { t } = useTranslation();
  const jobs = useSyncExternalStore(subscribeJobs, listJobs);
  const [open, setOpen] = useState(false);
  const [askOnClose, setAskOnClose] = useState(false);

  const active = jobs.filter((j) => j.state === 'running' || j.state === 'queued');
  const finished = jobs.filter((j) => j.state !== 'running' && j.state !== 'queued');

  // Đóng app khi job đang chạy = một bản restore nạp được một nửa, không resume được. Hỏi trước.
  // Blocker chứ không phải listener riêng — xem `closeGuard.ts`.
  useEffect(() => registerCloseBlocker(CLOSE_PRIORITY_JOBS, () => {
    if (activeJobs().length === 0) return false;
    setAskOnClose(true);
    return true;
  }), []);

  // Chưa từng có job nào thì không chiếm chỗ trên thanh tiêu đề.
  if (jobs.length === 0) return null;

  const failed = finished.some((j) => j.state === 'error');
  const capsuleTitle = active.length
    ? t('jobs.trayRunning', { n: active.length })
    : failed
      ? t('jobs.trayFailed')
      : t('jobs.trayIdle');

  return (
    <>
      {/* Bọc `.tb-capsule` như `TxControl`: lớp đó giữ chiều cao 34px và canh giữa của thanh tiêu
          đề, `.tb-capsule-btn` một mình chỉ có dáng của cái nút. */}
      <div className="tb-capsule" style={{ flexShrink: 0 }}>
        <button
          className={`tb-capsule-btn ${active.length ? 'is-active-accent' : ''} ${!active.length && failed ? 'is-active-warn' : ''}`}
          onClick={() => setOpen(true)}
          title={capsuleTitle}
          aria-label={capsuleTitle}
        >
          {active.length ? (
            <Loader2 size={13} className="loading-spinner" />
          ) : failed ? (
            <AlertTriangle size={13} />
          ) : (
            <ListChecks size={13} />
          )}
          {active.length > 0 && (
            <span style={{ fontSize: '10px', fontWeight: 600, marginLeft: '3px' }}>{active.length}</span>
          )}
        </button>
      </div>

      {open && (
        <Modal title={t('jobs.panelTitle')} onClose={() => setOpen(false)} zIndex={100000} width="520px">
          <ModalBody>
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ModalBody>
          <ModalFooter>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={finished.length === 0}
              onClick={clearFinishedJobs}
            >
              {t('jobs.clearFinished')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
              {t('common.close')}
            </button>
          </ModalFooter>
        </Modal>
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
    <CheckCircle2 size={13} style={{ color: 'var(--win-success, #22c55e)' }} />
  ) : job.state === 'error' ? (
    <AlertTriangle size={13} style={{ color: 'var(--win-danger, #ef4444)' }} />
  ) : job.state === 'cancelled' ? (
    <Ban size={13} style={{ color: 'var(--win-text-secondary)' }} />
  ) : (
    <ListChecks size={13} style={{ color: 'var(--win-text-secondary)' }} />
  );

  return (
    <div
      style={{
        display: 'flex',
        gap: '8px',
        padding: '8px 0',
        borderBottom: '1px solid var(--win-border)',
        alignItems: 'flex-start',
      }}
    >
      <div style={{ paddingTop: '1px' }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {job.title}
          </span>
          <span style={{ fontSize: '10px', color: 'var(--win-text-secondary)', flexShrink: 0 }}>
            {job.cancelRequested && running ? t('jobs.cancelling') : stateLabel}
          </span>
        </div>

        {/* Đang chờ vì có job khác đang ghi vào cùng database — nói ra, đừng để nó im ở 0%. */}
        {queued && (
          <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)' }}>{t('jobs.waitingTurn')}</div>
        )}

        {running && job.progress && (
          <ProgressBar progress={{ ...job.progress, label: job.progress.label || job.title }} />
        )}

        {job.error && (
          <div style={{ fontSize: '11px', lineHeight: 1.45, color: 'var(--win-danger, #ef4444)', wordBreak: 'break-word' }}>
            {job.error}
          </div>
        )}

        {job.result && (
          <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', wordBreak: 'break-word' }}>
            {job.result.message}
            {job.result.warning && (
              <div style={{ color: 'var(--win-warning, #f59e0b)' }}>{job.result.warning}</div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
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
