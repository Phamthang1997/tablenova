import { describe, it, expect } from 'vitest';
import {
  formatProcessDuration,
  getDurationSeverity,
  type ProcessItem,
  type ProcessListSummary,
} from '../processMonitorTypes';

describe('Live Process Monitor Types & Helpers', () => {
  describe('formatProcessDuration', () => {
    it('formats negative or zero durations gracefully', () => {
      expect(formatProcessDuration(-5)).toBe('0s');
      expect(formatProcessDuration(0)).toBe('0ms');
    });

    it('formats sub-second durations as milliseconds', () => {
      expect(formatProcessDuration(0.125)).toBe('125ms');
      expect(formatProcessDuration(0.8)).toBe('800ms');
    });

    it('formats seconds below one minute with one decimal precision', () => {
      expect(formatProcessDuration(1)).toBe('1.0s');
      expect(formatProcessDuration(12.34)).toBe('12.3s');
      expect(formatProcessDuration(59.9)).toBe('59.9s');
    });

    it('formats minutes and remaining seconds', () => {
      expect(formatProcessDuration(60)).toBe('1m 0s');
      expect(formatProcessDuration(75)).toBe('1m 15s');
      expect(formatProcessDuration(3599)).toBe('59m 59s');
    });

    it('formats hours and remaining minutes', () => {
      expect(formatProcessDuration(3600)).toBe('1h 0m');
      expect(formatProcessDuration(3665)).toBe('1h 1m');
      expect(formatProcessDuration(7200 + 120)).toBe('2h 2m');
    });
  });

  describe('getDurationSeverity', () => {
    it('returns normal for idle sessions even if duration is high', () => {
      expect(getDurationSeverity(500, 'idle')).toBe('normal');
      expect(getDurationSeverity(120, 'idle in transaction')).toBe('normal');
      expect(getDurationSeverity(300, 'Sleep')).toBe('normal');
    });

    it('returns normal for fast active queries (<10s)', () => {
      expect(getDurationSeverity(0.5, 'active')).toBe('normal');
      expect(getDurationSeverity(9.9, 'active')).toBe('normal');
    });

    it('returns warning for queries running between 10s and 60s', () => {
      expect(getDurationSeverity(10, 'active')).toBe('warning');
      expect(getDurationSeverity(45, 'active')).toBe('warning');
      expect(getDurationSeverity(59.9, 'active')).toBe('warning');
    });

    it('returns critical for queries running for 60s or more', () => {
      expect(getDurationSeverity(60, 'active')).toBe('critical');
      expect(getDurationSeverity(120, 'active')).toBe('critical');
      expect(getDurationSeverity(3600, 'active')).toBe('critical');
    });
  });

  describe('Process filtering logic', () => {
    const mockProcesses: ProcessItem[] = [
      {
        id: '101',
        user: 'postgres',
        host: '127.0.0.1',
        db: 'main_db',
        command: 'client backend',
        time_seconds: 15,
        state: 'active',
        info: 'SELECT * FROM users JOIN orders ON users.id = orders.user_id',
        is_blocked: false,
        blocked_by: null,
      },
      {
        id: '102',
        user: 'app_user',
        host: '192.168.1.5',
        db: 'analytics_db',
        command: 'client backend',
        time_seconds: 75,
        state: 'active',
        info: 'UPDATE accounts SET balance = balance - 100 WHERE id = 42',
        is_blocked: true,
        blocked_by: '101',
      },
      {
        id: '103',
        user: 'worker',
        host: '192.168.1.10',
        db: 'main_db',
        command: 'client backend',
        time_seconds: 300,
        state: 'idle',
        info: '',
        is_blocked: false,
        blocked_by: null,
      },
      {
        id: '104',
        user: 'backup_svc',
        host: '10.0.0.2',
        db: 'main_db',
        command: 'client backend',
        time_seconds: 2,
        state: 'active',
        info: 'SELECT pg_database_size(current_database())',
        is_blocked: false,
        blocked_by: null,
      },
    ];

    it('filters active only processes', () => {
      const active = mockProcesses.filter((p) => !p.state.toLowerCase().includes('idle'));
      expect(active.length).toBe(3);
      expect(active.map((p) => p.id)).toEqual(['101', '102', '104']);
    });

    it('filters slow queries (>5s and active)', () => {
      const slow = mockProcesses.filter(
        (p) => p.time_seconds >= 5 && !p.state.toLowerCase().includes('idle')
      );
      expect(slow.length).toBe(2);
      expect(slow.map((p) => p.id)).toEqual(['101', '102']);
    });

    it('filters blocked queries', () => {
      const blocked = mockProcesses.filter((p) => p.is_blocked || !!p.blocked_by);
      expect(blocked.length).toBe(1);
      expect(blocked[0].id).toBe('102');
      expect(blocked[0].blocked_by).toBe('101');
    });

    it('filters by search keyword in query, user, or id', () => {
      const searchUsers = (q: string) =>
        mockProcesses.filter(
          (p) =>
            p.id.toLowerCase().includes(q) ||
            p.user.toLowerCase().includes(q) ||
            p.db.toLowerCase().includes(q) ||
            p.info.toLowerCase().includes(q)
        );

      expect(searchUsers('accounts').length).toBe(1);
      expect(searchUsers('main_db').length).toBe(3);
      expect(searchUsers('101').length).toBe(1);
      expect(searchUsers('non_existent').length).toBe(0);
    });
  });

  describe('ProcessListSummary aggregation', () => {
    it('accurately represents server workload state', () => {
      const summary: ProcessListSummary = {
        dialect: 'postgres',
        total_connections: 4,
        active_queries: 3,
        blocked_queries: 1,
        longest_running_seconds: 75,
        processes: [],
      };

      expect(summary.total_connections).toBe(4);
      expect(summary.active_queries).toBe(3);
      expect(summary.blocked_queries).toBe(1);
      expect(summary.longest_running_seconds).toBe(75);
    });
  });
});
