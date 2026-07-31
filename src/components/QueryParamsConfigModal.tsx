import React, { useState } from 'react';
import { Settings, Check, X } from 'lucide-react';
import { QUERY_PARAM_PATTERNS, type QueryParamsConfig } from '../utils/queryParamHelper';

interface QueryParamsConfigModalProps {
  initialConfig: QueryParamsConfig;
  onSave: (newConfig: QueryParamsConfig) => void;
  onClose: () => void;
}

export const QueryParamsConfigModal: React.FC<QueryParamsConfigModalProps> = ({
  initialConfig,
  onSave,
  onClose
}) => {
  const [enabled, setEnabled] = useState(initialConfig.enabled);
  const [patternIndex, setPatternIndex] = useState(initialConfig.patternIndex);

  const handleSave = () => {
    onSave({ enabled, patternIndex });
    onClose();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.65)',
      display: 'flex', justifyContent: 'center', alignItems: 'center',
      zIndex: 10000, backdropFilter: 'blur(2px)'
    }} onClick={onClose}>
      <div style={{
        background: 'var(--win-bg-card)',
        border: '1px solid var(--win-border-strong, var(--win-border))',
        borderRadius: '8px',
        width: '440px',
        boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px'
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Settings size={18} style={{ color: 'var(--win-accent)' }} />
            <h3 style={{ margin: 0, fontSize: '15px', color: 'var(--win-text-primary)' }}>
              Tùy chọn Tham số Truy vấn (Query Params Options)
            </h3>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Enable Checkbox */}
        <div style={{
          background: 'rgba(0,0,0,0.1)',
          padding: '12px',
          borderRadius: '6px',
          border: '1px solid var(--win-border)'
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontSize: '12px', color: 'var(--win-text-primary)', fontWeight: 600 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: '15px', height: '15px', accentColor: 'var(--win-accent)' }}
            />
            <span>Bật tham số truy vấn (Enable query params)</span>
          </label>
          <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', marginTop: '4px', marginLeft: '25px' }}>
            Khi bật, trình viết SQL sẽ tự động nhận diện tham số và nhắc bạn nhập giá trị trước khi chạy truy vấn.
          </div>
        </div>

        {/* Patterns list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
            Mẫu nhận diện biến tham số (Query Param Regex):
          </div>
          {QUERY_PARAM_PATTERNS.map((p) => (
            <label
              key={p.id}
              onClick={() => setPatternIndex(p.id)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '10px 12px',
                borderRadius: '6px',
                border: patternIndex === p.id ? '1px solid var(--win-accent)' : '1px solid var(--win-border)',
                background: patternIndex === p.id ? 'rgba(0, 102, 204, 0.08)' : 'var(--win-bg-window)',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              <input
                type="radio"
                name="paramPattern"
                checked={patternIndex === p.id}
                onChange={() => setPatternIndex(p.id)}
                style={{ marginTop: '2px', accentColor: 'var(--win-accent)' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                  <code style={{ background: 'rgba(255,255,255,0.08)', padding: '2px 6px', borderRadius: '3px', fontFamily: 'var(--win-font-mono)' }}>
                    {p.label}
                  </code>
                </div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'var(--win-font-mono)' }}>
                  Ví dụ: {p.example}
                </div>
              </div>
            </label>
          ))}
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
          <button className="btn btn-secondary" onClick={onClose} style={{ padding: '6px 16px' }}>
            Hủy
          </button>
          <button className="btn btn-primary" onClick={handleSave} style={{ padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Check size={14} />
            <span>Lưu cài đặt</span>
          </button>
        </div>
      </div>
    </div>
  );
};
