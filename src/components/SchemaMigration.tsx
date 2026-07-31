import React, { useState, useEffect, useRef } from 'react';
import { X, Camera, Trash2, GitCompare, Download, Upload, Copy, Loader } from 'lucide-react';
import {
  listSnapshots,
  saveSnapshot,
  deleteSnapshot,
  captureCurrentSchema,
  diffSchemas,
  buildMigrationSql,
  type SchemaSnapshot,
  type SchemaDiff,
} from '../utils/schemaSnapshot';

interface SchemaMigrationProps {
  dbType: string;
  database?: string;
  onClose: () => void;
}

export const SchemaMigration: React.FC<SchemaMigrationProps> = ({ dbType, database, onClose }) => {
  const [snapshots, setSnapshots] = useState<SchemaSnapshot[]>([]);
  const [snapName, setSnapName] = useState('');
  const [busy, setBusy] = useState<string>(''); // thông báo trạng thái đang xử lý
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [migrationSql, setMigrationSql] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = () => setSnapshots(listSnapshots());
  useEffect(() => { refresh(); }, []);

  const defaultName = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${database || dbType}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  };

  const handleCapture = async () => {
    setError(null);
    const name = (snapName.trim() || defaultName());
    setBusy(`Đang chụp schema "${name}"...`);
    try {
      const snap = await captureCurrentSchema(name, dbType, database);
      saveSnapshot(snap);
      setSnapName('');
      refresh();
      setBusy(`Đã lưu snapshot "${name}" (${Object.keys(snap.tables).length} bảng).`);
    } catch (e: any) {
      setError('Lỗi chụp schema: ' + (e?.message || e));
      setBusy('');
    }
  };

  const handleDelete = (name: string) => {
    deleteSnapshot(name);
    if (selected === name) { setSelected(null); setDiff(null); setMigrationSql(''); }
    refresh();
  };

  const handleExport = (snap: SchemaSnapshot) => {
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${snap.name}.schema.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const snap = JSON.parse(await file.text()) as SchemaSnapshot;
      if (!snap || !snap.tables || typeof snap.tables !== 'object') throw new Error('File snapshot không hợp lệ.');
      if (!snap.name) snap.name = file.name.replace(/\.schema\.json$|\.json$/i, '');
      saveSnapshot(snap);
      refresh();
      setBusy(`Đã nhập snapshot "${snap.name}".`);
    } catch (err: any) {
      setError('Lỗi đọc file snapshot: ' + (err?.message || err));
    }
  };

  const handleCompare = async (name: string) => {
    setError(null);
    setSelected(name);
    setDiff(null);
    setMigrationSql('');
    const baseline = listSnapshots().find((s) => s.name === name);
    if (!baseline) { setError('Không tìm thấy snapshot.'); return; }
    setBusy('Đang so sánh với schema hiện tại...');
    try {
      const current = await captureCurrentSchema('__current__', dbType, database);
      const d = diffSchemas(baseline, current);
      setDiff(d);
      if (d.identical) {
        setMigrationSql('-- Không có khác biệt giữa snapshot và schema hiện tại.');
      } else {
        const sql = await buildMigrationSql(d, current, baseline, dbType);
        setMigrationSql(sql);
      }
      setBusy('');
    } catch (e: any) {
      setError('Lỗi so sánh: ' + (e?.message || e));
      setBusy('');
    }
  };

  const copySql = () => {
    navigator.clipboard.writeText(migrationSql);
    setBusy('Đã sao chép migration SQL.');
  };

  const downloadSql = () => {
    const blob = new Blob([migrationSql], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `migration_${selected || 'schema'}.sql`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const label = { fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' } as React.CSSProperties;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 10000 }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '860px', maxWidth: '94vw', height: '80vh', background: 'var(--win-bg-card)',
          border: '1px solid var(--win-border-strong, var(--win-border))', borderRadius: '8px',
          display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--win-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <GitCompare size={16} style={{ color: 'var(--win-accent)' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--win-text-primary)' }}>Diff Schema & Migration</span>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer' }}><X size={16} /></button>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Cột trái: snapshots */}
          <div style={{ width: '300px', borderRight: '1px solid var(--win-border)', display: 'flex', flexDirection: 'column', padding: '12px', gap: '10px', overflow: 'hidden' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={label}>Chụp schema hiện tại</span>
              <input
                type="text"
                value={snapName}
                onChange={(e) => setSnapName(e.target.value)}
                placeholder={defaultName()}
                style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', padding: '6px 8px', fontSize: '12px', outline: 'none' }}
              />
              <div style={{ display: 'flex', gap: '6px' }}>
                <button className="btn btn-primary" onClick={handleCapture} disabled={!!busy && busy.startsWith('Đang')} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                  <Camera size={13} /> Chụp
                </button>
                <button className="btn btn-secondary" title="Nhập snapshot từ file" onClick={() => fileInputRef.current?.click()} style={{ width: '34px', height: '28px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Upload size={14} />
                </button>
                <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} />
              </div>
            </div>

            <div style={{ ...label, borderTop: '1px solid var(--win-border)', paddingTop: '8px' }}>Snapshots đã lưu ({snapshots.length})</div>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {snapshots.length === 0 && <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>Chưa có snapshot nào.</div>}
              {snapshots.map((s) => (
                <div
                  key={s.name}
                  style={{
                    border: '1px solid ' + (selected === s.name ? 'var(--win-accent)' : 'var(--win-border)'),
                    borderRadius: '4px', padding: '6px 8px', background: selected === s.name ? 'rgba(0,102,204,0.08)' : 'var(--win-bg-window)',
                  }}
                >
                  <div style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>{s.name}</div>
                  <div style={{ fontSize: '10px', color: 'var(--win-text-disabled)', marginTop: '2px' }}>
                    {Object.keys(s.tables || {}).length} bảng · {new Date(s.createdAt).toLocaleString('vi-VN')}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                    <button className="btn btn-primary" onClick={() => handleCompare(s.name)} style={{ flex: 1, height: '26px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '0 8px' }}>
                      <GitCompare size={12} /> So sánh
                    </button>
                    <button className="btn btn-secondary" title="Xuất file" onClick={() => handleExport(s)} style={{ width: '28px', height: '26px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Download size={13} /></button>
                    <button className="btn btn-secondary" title="Xóa" onClick={() => handleDelete(s.name)} style={{ width: '28px', height: '26px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--st-danger)' }}><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Cột phải: kết quả diff + migration */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '12px', gap: '10px', overflow: 'hidden' }}>
            {error && (
              <div style={{ fontSize: '11px', color: 'var(--st-danger)', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '4px', padding: '6px 8px' }}>{error}</div>
            )}
            {busy && !error && (
              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                {busy.startsWith('Đang') && <Loader size={12} className="loading-spinner" />}{busy}
              </div>
            )}

            {!selected && !busy && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--win-text-disabled)', fontSize: '12px', textAlign: 'center', padding: '0 24px' }}>
                Chụp snapshot schema hiện tại, thay đổi cấu trúc DB, rồi bấm "So sánh" trên một snapshot để xem khác biệt và sinh script migration.
              </div>
            )}

            {diff && (
              <>
                <div style={label}>Khác biệt (baseline "{selected}" → hiện tại)</div>
                <div style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--win-border)', borderRadius: '4px', padding: '8px', fontSize: '11.5px', background: 'var(--win-bg-window)' }}>
                  {diff.identical && <div style={{ color: 'var(--win-text-secondary)' }}>Không có khác biệt.</div>}
                  {diff.addedTables.map((t) => (
                    <div key={'a' + t} style={{ color: 'var(--st-ok)' }}>+ Bảng mới: {t}</div>
                  ))}
                  {diff.droppedTables.map((t) => (
                    <div key={'d' + t} style={{ color: 'var(--st-danger)' }}>− Bảng bị xóa: {t}</div>
                  ))}
                  {diff.changedTables.map((c) => (
                    <div key={'c' + c.table} style={{ color: 'var(--st-warn)' }}>~ {c.table}: {c.summary.join(', ')}</div>
                  ))}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={label}>Migration SQL</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button className="btn btn-secondary" onClick={copySql} disabled={!migrationSql} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}><Copy size={11} /> Sao chép</button>
                    <button className="btn btn-secondary" onClick={downloadSql} disabled={!migrationSql} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}><Download size={11} /> Tải .sql</button>
                  </div>
                </div>
                <textarea
                  readOnly
                  value={migrationSql}
                  style={{ flex: 1, width: '100%', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', fontFamily: 'var(--win-font-mono)', fontSize: '11px', padding: '10px', borderRadius: '4px', resize: 'none', outline: 'none' }}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
