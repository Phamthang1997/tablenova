import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  JobCancelledError,
  cancelJob,
  clearFinishedJobs,
  hasActiveJobs,
  listJobs,
  resetJobs,
  startJob,
  subscribeJobs,
  type JobProgress,
} from '../jobs';

/** Waits until `check()` holds — a job settles after a few microtasks, not after a fixed tick. */
const until = async (check: () => boolean, tries = 200): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('điều kiện không bao giờ đúng');
};

const jobById = (id: string) => listJobs().find((j) => j.id === id);

/** An open promise, so a test can hold a job in the running state for as long as it likes. */
function gate() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetJobs();
});

describe('vòng đời một job', () => {
  it('chạy, báo tiến độ, kết thúc ở done kèm kết quả', async () => {
    const g = gate();
    const seen: (JobProgress | null)[] = [];
    const id = startJob({
      kind: 'dump',
      title: 'Backup — sakila',
      db: 'sakila',
      run: async (ctx) => {
        ctx.report({ label: 'đang đọc', current: 1, total: 2 });
        seen.push(jobById(id)?.progress ?? null);
        await g.promise;
        return { message: 'xong', path: 'C:/tmp/bk.sql' };
      },
    });

    await until(() => jobById(id)?.state === 'running');
    expect(seen[0]).toEqual({ label: 'đang đọc', current: 1, total: 2 });

    g.resolve();
    await until(() => jobById(id)?.state === 'done');
    const rec = jobById(id)!;
    expect(rec.result).toEqual({ message: 'xong', path: 'C:/tmp/bk.sql' });
    // Progress is cleared on settle: the bar must not be left standing at 50% once the job is done.
    expect(rec.progress).toBeNull();
    expect(rec.endedAt).toBeTruthy();
    expect(hasActiveJobs()).toBe(false);
  });

  it('run ném lỗi -> state error, giữ nguyên thông báo (kể cả khi lỗi là string)', async () => {
    const id = startJob({
      kind: 'restore',
      title: 'Restore',
      db: 'db1',
      // dbHelper rethrows a *string*, not an Error — see its local invoke.
      run: async () => {
        throw 'Không kết nối được máy chủ';
      },
    });
    await until(() => jobById(id)?.state === 'error');
    expect(jobById(id)?.error).toBe('Không kết nối được máy chủ');
  });

  it('snapshot đổi tham chiếu mỗi lần state đổi (useSyncExternalStore mới re-render)', async () => {
    const before = listJobs();
    const id = startJob({ kind: 'dump', title: 'x', run: async () => {} });
    expect(listJobs()).not.toBe(before);
    await until(() => jobById(id)?.state === 'done');
  });
});

describe('huỷ', () => {
  it('job đang chạy: gọi onCancel, vòng lặp thấy cancelled(), settle thành cancelled', async () => {
    const g = gate();
    const onCancel = vi.fn();
    const id = startJob({
      kind: 'generate',
      title: 'Generate',
      db: 'db1',
      write: true,
      onCancel,
      run: async (ctx) => {
        await g.promise;
        ctx.throwIfCancelled();
        return { message: 'không bao giờ tới đây' };
      },
    });

    await until(() => jobById(id)?.state === 'running');
    cancelJob(id);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(jobById(id)?.cancelRequested).toBe(true);

    g.resolve();
    await until(() => jobById(id)?.state === 'cancelled');
    expect(jobById(id)?.error).toBeNull();
  });

  it('run trả về bình thường sau khi bị huỷ vẫn tính là cancelled, không phải done', async () => {
    const g = gate();
    const id = startJob({
      kind: 'redis-transfer',
      title: 'Transfer',
      run: async () => {
        await g.promise;
        return { message: 'đã ghi được một phần' };
      },
    });
    await until(() => jobById(id)?.state === 'running');
    cancelJob(id);
    g.resolve();
    await until(() => jobById(id)?.state === 'cancelled');
  });

  it('job còn trong hàng đợi thì run KHÔNG bao giờ được gọi', async () => {
    const g = gate();
    const ran = vi.fn();
    const first = startJob({
      kind: 'restore', title: 'A', db: 'db1', write: true,
      run: async () => { await g.promise; },
    });
    const second = startJob({
      kind: 'restore', title: 'B', db: 'db1', write: true,
      run: async () => { ran(); },
    });

    await until(() => jobById(first)?.state === 'running');
    expect(jobById(second)?.state).toBe('queued');

    cancelJob(second);
    expect(jobById(second)?.state).toBe('cancelled');
    g.resolve();
    await until(() => jobById(first)?.state === 'done');
    expect(ran).not.toHaveBeenCalled();
  });

  it('onCancel ném lỗi thì job vẫn chạy tiếp và vẫn settle được', async () => {
    const g = gate();
    const id = startJob({
      kind: 'generate', title: 'G', db: 'db1', write: true,
      onCancel: () => { throw new Error('backend không trả lời'); },
      run: async (ctx) => { await g.promise; ctx.throwIfCancelled(); },
    });
    await until(() => jobById(id)?.state === 'running');
    expect(() => cancelJob(id)).not.toThrow();
    g.resolve();
    await until(() => jobById(id)?.state === 'cancelled');
  });
});

describe('độc quyền và hàng đợi', () => {
  it('hai job GHI cùng một database: cái sau chờ', async () => {
    const g1 = gate();
    const a = startJob({ kind: 'restore', title: 'A', db: 'db1', lockKey: 'srv|db1', write: true, run: async () => { await g1.promise; } });
    const b = startJob({ kind: 'generate', title: 'B', db: 'db1', lockKey: 'srv|db1', write: true, run: async () => {} });

    await until(() => jobById(a)?.state === 'running');
    expect(jobById(b)?.state).toBe('queued');

    g1.resolve();
    await until(() => jobById(b)?.state === 'done');
    expect(jobById(a)?.state).toBe('done');
  });

  it('job ĐỌC cũng phải chờ job GHI trên cùng database (dump sẽ bị xé)', async () => {
    const g = gate();
    const w = startJob({ kind: 'restore', title: 'W', lockKey: 'srv|db1', write: true, run: async () => { await g.promise; } });
    const r = startJob({ kind: 'dump', title: 'R', lockKey: 'srv|db1', run: async () => {} });

    await until(() => jobById(w)?.state === 'running');
    expect(jobById(r)?.state).toBe('queued');
    g.resolve();
    await until(() => jobById(r)?.state === 'done');
  });

  it('hai job ĐỌC cùng database chạy song song', async () => {
    const g = gate();
    const a = startJob({ kind: 'dump', title: 'A', lockKey: 'srv|db1', run: async () => { await g.promise; } });
    const b = startJob({ kind: 'dump', title: 'B', lockKey: 'srv|db1', run: async () => { await g.promise; } });
    await until(() => jobById(a)?.state === 'running' && jobById(b)?.state === 'running');
    g.resolve();
    await until(() => jobById(b)?.state === 'done');
  });

  it('job GHI trên database khác không bị chặn', async () => {
    const g = gate();
    const a = startJob({ kind: 'restore', title: 'A', lockKey: 'srv|db1', write: true, run: async () => { await g.promise; } });
    const b = startJob({ kind: 'restore', title: 'B', lockKey: 'srv|db2', write: true, run: async () => { await g.promise; } });
    await until(() => jobById(a)?.state === 'running' && jobById(b)?.state === 'running');
    g.resolve();
    await until(() => jobById(b)?.state === 'done');
  });

  it('tối đa 3 job chạy cùng lúc, cái thứ tư vào hàng đợi', async () => {
    const g = gate();
    const ids = ['a', 'b', 'c', 'd'].map((n) =>
      startJob({ kind: 'dump', title: n, lockKey: `srv|${n}`, run: async () => { await g.promise; } })
    );
    await until(() => ids.filter((id) => jobById(id)?.state === 'running').length === 3);
    expect(jobById(ids[3])?.state).toBe('queued');

    g.resolve();
    await until(() => ids.every((id) => jobById(id)?.state === 'done'));
  });
});

describe('subscriber', () => {
  it('gộp nhiều lần báo tiến độ thành ít lần thông báo', async () => {
    vi.useFakeTimers();
    try {
      const notify = vi.fn();
      const un = subscribeJobs(notify);
      const g = gate();
      const id = startJob({
        kind: 'dump', title: 'x',
        run: async (ctx) => {
          for (let i = 0; i < 50; i++) ctx.report({ current: i, total: 50 });
          await g.promise;
        },
      });
      // startJob (adding the job) and launch (running) are two immediate notifications.
      const afterStart = notify.mock.calls.length;
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 50; i++) {
        // 50 reports produce just ONE notification after the coalescing window.
      }
      await vi.advanceTimersByTimeAsync(200);
      expect(notify.mock.calls.length).toBeLessThanOrEqual(afterStart + 3);
      expect(jobById(id)?.progress?.current).toBe(49);
      g.resolve();
      un();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearFinishedJobs xoá job đã xong, giữ job đang chạy', async () => {
    const g = gate();
    const running = startJob({ kind: 'dump', title: 'R', lockKey: 'a', run: async () => { await g.promise; } });
    const done = startJob({ kind: 'dump', title: 'D', lockKey: 'b', run: async () => {} });
    await until(() => jobById(done)?.state === 'done');

    clearFinishedJobs();
    expect(jobById(done)).toBeUndefined();
    expect(jobById(running)?.state).toBe('running');

    g.resolve();
    await until(() => jobById(running)?.state === 'done');
  });

  it('chỉ giữ lại 20 job đã kết thúc gần nhất', async () => {
    for (let i = 0; i < 25; i++) {
      startJob({ kind: 'dump', title: `j${i}`, lockKey: `k${i}`, run: async () => {} });
    }
    await until(() => listJobs().every((j) => j.state === 'done') && listJobs().length <= 20);
    expect(listJobs()).toHaveLength(20);
  });
});

describe('JobCancelledError', () => {
  it('run tự ném JobCancelledError cũng thành cancelled, không phải error', async () => {
    const id = startJob({ kind: 'dump', title: 'x', run: async () => { throw new JobCancelledError(); } });
    await until(() => jobById(id)?.state === 'cancelled');
    expect(jobById(id)?.error).toBeNull();
  });
});
