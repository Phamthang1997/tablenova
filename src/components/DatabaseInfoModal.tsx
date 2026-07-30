import React, { useState, useEffect, useMemo } from 'react';
import { dbHelper, type DatabaseStats } from '../utils/dbHelper';
import { X, RefreshCw, HardDrive, Hash, Table, Search, ArrowUpDown, ExternalLink, ShieldCheck } from 'lucide-react';

interface DatabaseInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTable: (tableName: string) => void;
}

export const DatabaseInfoModal: React.FC<DatabaseInfoModalProps> = ({
  isOpen,
  onClose,
  onSelectTable,
}) => {
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'size_desc' | 'rows_desc' | 'name_asc'>('size_desc');
  const [exactCounts, setExactCounts] = useState<Record<string, number>>({});
  const [countingTable, setCountingTable] = useState<string | null>(null);

  const fetchStats = async () => {
    setLoading(true);
    setError(null);
    const res = await dbHelper.getDatabaseStats();
    setLoading(false);
    if (res.success && res.stats) {
      setStats(res.stats);
    } else {
      setError(res.error || 'Không thể lấy thông tin database');
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchStats();
    }
  }, [isOpen]);

  const handleFetchExactCount = async (tableName: string) => {
    setCountingTable(tableName);
    const res = await dbHelper.getExactTableRowCount(tableName);
    setCountingTable(null);
    if (res.success && res.exact_rows !== undefined) {
      setExactCounts((prev) => ({ ...prev, [tableName]: Math.max(0, res.exact_rows!) }));
    }
  };

  const formatBytes = (bytes: number | null | undefined): string => {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return '-';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const filteredTables = useMemo(() => {
    if (!stats?.tables) return [];
    let list = stats.tables.filter((t) =>
      t.table_name.toLowerCase().includes(searchTerm.toLowerCase().trim())
    );

    return list.sort((a, b) => {
      if (sortBy === 'size_desc') {
        const sizeA = a.total_size_bytes ?? 0;
        const sizeB = b.total_size_bytes ?? 0;
        return sizeB - sizeA;
      }
      if (sortBy === 'rows_desc') {
        const rowsA = Math.max(0, exactCounts[a.table_name] ?? a.rows);
        const rowsB = Math.max(0, exactCounts[b.table_name] ?? b.rows);
        return rowsB - rowsA;
      }
      return a.table_name.localeCompare(b.table_name);
    });
  }, [stats, searchTerm, sortBy, exactCounts]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div
        style={{
          width: '95%',
          maxWidth: '1100px',
          height: '85vh',
          maxHeight: '90vh',
          background: 'var(--win-bg-card)',
          border: '1px solid var(--win-border-strong, var(--win-border))',
          borderRadius: '10px',
          boxShadow: '0 25px 60px rgba(0, 0, 0, 0.45)',
          display: 'flex',
          flexDirection: 'column',
          color: 'var(--win-text-primary)',
          overflow: 'hidden',
          fontFamily: 'var(--win-font-sans, system-ui, sans-serif)',
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 24px',
            borderBottom: '1px solid var(--win-border)',
            background: 'var(--win-bg-tab-bar)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                padding: '9px',
                borderRadius: '8px',
                background: 'var(--win-accent-glow)',
                color: 'var(--win-accent)',
                display: 'flex',
              }}
            >
              <HardDrive size={20} />
            </div>
            <div>
              <h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0, color: 'var(--win-text-primary)' }}>
                Thông tin Database: <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600 }}>{stats?.db_name || '...'}</span>
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px' }}>
                <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Loại DB:</span>
                <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--win-accent)', background: 'var(--win-accent-glow)', border: '1px solid var(--win-border)', padding: '1px 8px', borderRadius: '4px', letterSpacing: '0.05em' }}>
                  {stats?.db_type || '-'}
                </span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={fetchStats}
              disabled={loading}
              title="Làm mới thống kê"
              style={{
                background: 'var(--win-bg-hover)',
                border: '1px solid var(--win-border)',
                color: 'var(--win-text-secondary)',
                cursor: loading ? 'default' : 'pointer',
                padding: '7px 14px',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                fontWeight: 500,
                opacity: loading ? 0.5 : 1,
              }}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              <span>{loading ? 'Đang tải...' : 'Làm mới'}</span>
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--win-text-secondary)',
                cursor: 'pointer',
                padding: '6px',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {error && (
            <div style={{ padding: '12px 16px', background: 'var(--win-status-deleted)', border: '1px solid var(--win-status-deleted-border)', borderRadius: '6px', color: 'var(--win-status-deleted-border)', fontSize: '13px' }}>
              {error}
            </div>
          )}

          {/* Overview Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
            {/* Card 1: Total Size */}
            <div style={{ padding: '16px 20px', borderRadius: '8px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--win-text-secondary)', fontWeight: 500, marginBottom: '4px' }}>Dung lượng Database</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--win-text-primary)' }}>{formatBytes(stats?.total_size_bytes)}</div>
              </div>
              <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--win-accent-glow)', color: 'var(--win-accent)', display: 'flex' }}>
                <HardDrive size={22} />
              </div>
            </div>

            {/* Card 2: Total Rows */}
            <div style={{ padding: '16px 20px', borderRadius: '8px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--win-text-secondary)', fontWeight: 500, marginBottom: '4px' }}>Tổng số bản ghi</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--win-text-primary)' }}>
                  {stats?.total_rows !== undefined ? Math.max(0, stats.total_rows).toLocaleString() : '-'}
                </div>
              </div>
              <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--win-status-added)', color: 'var(--win-status-added-border)', display: 'flex' }}>
                <Hash size={22} />
              </div>
            </div>

            {/* Card 3: Total Tables */}
            <div style={{ padding: '16px 20px', borderRadius: '8px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--win-text-secondary)', fontWeight: 500, marginBottom: '4px' }}>Tổng số bảng</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--win-text-primary)' }}>{stats?.total_tables ?? 0}</div>
              </div>
              <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(168, 85, 247, 0.15)', color: '#a855f7', display: 'flex' }}>
                <Table size={22} />
              </div>
            </div>
          </div>

          {/* Search & Sorting Bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: '300px' }}>
              <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--win-text-disabled)' }} />
              <input
                type="text"
                placeholder="Tìm kiếm tên bảng..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{
                  width: '100%',
                  background: 'var(--win-bg-window)',
                  border: '1px solid var(--win-border)',
                  borderRadius: '6px',
                  paddingLeft: '34px',
                  paddingRight: '12px',
                  paddingTop: '8px',
                  paddingBottom: '8px',
                  fontSize: '12px',
                  color: 'var(--win-text-primary)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
              <ArrowUpDown size={14} style={{ color: 'var(--win-text-secondary)' }} />
              <select
                value={sortBy}
                onChange={(e: any) => setSortBy(e.target.value)}
                style={{
                  background: 'var(--win-bg-window)',
                  border: '1px solid var(--win-border)',
                  color: 'var(--win-text-primary)',
                  fontSize: '12px',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                <option value="size_desc">Dung lượng (Giảm dần)</option>
                <option value="rows_desc">Số dòng (Giảm dần)</option>
                <option value="name_asc">Tên bảng (A - Z)</option>
              </select>
            </div>
          </div>

          {/* Table List Data Grid */}
          <div style={{ flex: 1, border: '1px solid var(--win-border)', borderRadius: '8px', overflow: 'hidden', background: 'var(--win-bg-window)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ overflowX: 'auto', flex: 1 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'var(--win-bg-tab-bar)', borderBottom: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    <th style={{ padding: '12px 16px' }}>Tên bảng</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Số bản ghi (Rows)</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Data Size</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Index Size</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Tổng dung lượng</th>
                    <th style={{ padding: '12px 16px', textAlign: 'center' }}>Engine</th>
                    <th style={{ padding: '12px 16px', textAlign: 'center' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--win-text-secondary)' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '10px', fontSize: '13px', fontWeight: 500 }}>
                          <RefreshCw size={18} className="animate-spin" style={{ color: 'var(--win-accent)' }} />
                          <span>Đang tải thống kê database...</span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredTables.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: '40px', color: 'var(--win-text-disabled)' }}>
                        Không tìm thấy bảng phù hợp
                      </td>
                    </tr>
                  ) : (
                    filteredTables.map((t) => {
                      const isExact = exactCounts[t.table_name] !== undefined || t.is_exact;
                      const rawRows = exactCounts[t.table_name] ?? t.rows;
                      const displayRows = Math.max(0, rawRows);
                      const isCounting = countingTable === t.table_name;

                      return (
                        <tr
                          key={t.table_name}
                          style={{ borderBottom: '1px solid var(--win-border)', transition: 'background 0.12s' }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--win-bg-hover)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          <td style={{ padding: '10px 16px', fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600, color: 'var(--win-accent)' }}>
                            {t.table_name}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', color: 'var(--win-text-primary)' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                              {!isExact && <span style={{ color: 'var(--win-text-disabled)', fontFamily: 'sans-serif' }}>~</span>}
                              <span>{displayRows.toLocaleString()}</span>
                              {!isExact && (
                                <button
                                  onClick={() => handleFetchExactCount(t.table_name)}
                                  disabled={isCounting}
                                  title="Đếm chính xác (SELECT COUNT(*))"
                                  style={{
                                    background: 'var(--win-bg-hover)',
                                    border: '1px solid var(--win-border)',
                                    color: 'var(--win-text-secondary)',
                                    cursor: isCounting ? 'default' : 'pointer',
                                    padding: '2px 5px',
                                    borderRadius: '4px',
                                    display: 'inline-flex',
                                  }}
                                >
                                  <RefreshCw size={12} className={isCounting ? 'animate-spin' : ''} style={{ color: isCounting ? 'var(--win-accent)' : undefined }} />
                                </button>
                              )}
                              {isExact && (
                                <span title="Số dòng chính xác 100%">
                                  <ShieldCheck size={14} style={{ color: 'var(--win-status-added-border, #10b981)', verticalAlign: 'middle' }} />
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', color: 'var(--win-text-secondary)' }}>
                            {formatBytes(t.data_size_bytes)}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', color: 'var(--win-text-secondary)' }}>
                            {formatBytes(t.index_size_bytes)}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                            {formatBytes(t.total_size_bytes)}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                            <span style={{ padding: '2px 8px', fontSize: '11px', fontWeight: 500, background: 'var(--win-bg-tab-bar)', borderRadius: '4px', border: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>
                              {t.engine || '-'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                            <button
                              onClick={() => {
                                onSelectTable(t.table_name);
                                onClose();
                              }}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '5px',
                                fontSize: '11px',
                                fontWeight: 500,
                                color: '#ffffff',
                                background: 'var(--win-accent)',
                                border: 'none',
                                padding: '5px 12px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                                flexShrink: 0,
                              }}
                            >
                              <span>Xem dữ liệu</span>
                              <ExternalLink size={12} />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 24px',
            borderTop: '1px solid var(--win-border)',
            background: 'var(--win-bg-tab-bar)',
            fontSize: '12px',
            color: 'var(--win-text-secondary)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--win-status-added-border, #10b981)' }} />
            <span>Hệ thống tự động sử dụng Catalog Metadata giúp bảo vệ hiệu năng Production DB</span>
          </div>
          <button
            onClick={onClose}
            style={{
              padding: '7px 20px',
              background: 'var(--win-bg-btn-secondary)',
              border: '1px solid var(--win-border-btn-secondary)',
              color: 'var(--win-text-btn-secondary)',
              fontSize: '12px',
              fontWeight: 500,
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};
