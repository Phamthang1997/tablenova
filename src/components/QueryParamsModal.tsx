import React, { useState, useEffect } from 'react';
import { Play, X } from 'lucide-react';

interface QueryParamsModalProps {
  params: string[];
  sqlPreview: string;
  onSubmit: (valuesMap: Record<string, string>) => void;
  onClose: () => void;
}

export const QueryParamsModal: React.FC<QueryParamsModalProps> = ({
  params,
  sqlPreview,
  onSubmit,
  onClose
}) => {
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    const stored = localStorage.getItem('sql_query_param_values');
    let lastValues: Record<string, string> = {};
    if (stored) {
      try { lastValues = JSON.parse(stored); } catch { lastValues = {}; }
    }
    const initial: Record<string, string> = {};
    params.forEach(p => {
      initial[p] = lastValues[p] !== undefined ? lastValues[p] : '';
    });
    setValues(initial);
  }, [params]);

  const handleChange = (paramName: string, value: string) => {
    setValues(prev => ({ ...prev, [paramName]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Save last used parameter values to localStorage
    const stored = localStorage.getItem('sql_query_param_values');
    let lastValues: Record<string, string> = {};
    if (stored) {
      try { lastValues = JSON.parse(stored); } catch { lastValues = {}; }
    }
    const updated = { ...lastValues, ...values };
    localStorage.setItem('sql_query_param_values', JSON.stringify(updated));

    onSubmit(values);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.65)',
      display: 'flex', justifyContent: 'center', alignItems: 'center',
      zIndex: 10000, backdropFilter: 'blur(2px)'
    }} onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        style={{
          background: 'var(--win-bg-card)',
          border: '1px solid var(--win-border-strong, var(--win-border))',
          borderRadius: '8px',
          width: '460px',
          maxWidth: '90vw',
          maxHeight: '85vh',
          boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Play size={16} style={{ color: 'var(--win-accent)', fill: 'var(--win-accent)' }} />
            <h3 style={{ margin: 0, fontSize: '15px', color: 'var(--win-text-primary)' }}>
              Nhập Tham số Truy vấn (Enter Query Parameters)
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* SQL Preview Snippet */}
        <div style={{
          background: 'var(--win-bg-window)',
          padding: '8px 12px',
          borderRadius: '4px',
          border: '1px solid var(--win-border)',
          fontSize: '11px',
          fontFamily: 'var(--win-font-mono)',
          color: 'var(--win-text-secondary)',
          maxHeight: '70px',
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all'
        }}>
          {sqlPreview}
        </div>

        {/* Parameter Input Fields */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          maxHeight: '300px',
          overflowY: 'auto',
          paddingRight: '4px'
        }}>
          {params.map((p, idx) => (
            <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--win-text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: '3px', fontFamily: 'var(--win-font-mono)', color: 'var(--win-accent)' }}>
                  {p}
                </code>
              </label>
              <input
                type="text"
                autoFocus={idx === 0}
                value={values[p] || ''}
                onChange={(e) => handleChange(p, e.target.value)}
                placeholder={`Nhập giá trị cho ${p}...`}
                style={{
                  background: 'var(--win-bg-window)',
                  border: '1px solid var(--win-border)',
                  color: 'var(--win-text-primary)',
                  borderRadius: '4px',
                  padding: '6px 10px',
                  fontSize: '12px',
                  fontFamily: 'var(--win-font-mono)',
                  outline: 'none'
                }}
              />
            </div>
          ))}
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} style={{ padding: '6px 16px', fontSize: '12px' }}>
            Hủy
          </button>
          <button type="submit" className="btn btn-primary" style={{ padding: '6px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Play size={12} fill="#fff" />
            <span>Chạy truy vấn</span>
          </button>
        </div>
      </form>
    </div>
  );
};
