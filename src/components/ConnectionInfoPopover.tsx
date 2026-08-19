import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ConnectionStatus } from '../utils/dbHelper';
import { CONN_ENVS, envLabelKey, normalizeEnv, type ConnEnv } from '../utils/connEnv';

/**
 * Bảng chi tiết kết nối, mở khi bấm vào cụm trạng thái giữa thanh tiêu đề.
 *
 * Không dựng từ Modal.tsx: đây là popover neo theo cụm trạng thái chứ không
 * phải hộp thoại giữa màn hình, và nó không chặn thao tác phía sau. Vẫn render
 * qua portal vì thanh tiêu đề nằm trong nhánh có backdrop-filter — position:
 * fixed trong đó chỉ phủ được phần thanh tiêu đề (xem ghi chú ở Modal.tsx).
 */

interface ConnectionInfoPopoverProps {
  /** Vị trí đã tính sẵn từ getBoundingClientRect của cụm trạng thái. */
  anchor: { top: number; left: number };
  status: ConnectionStatus | null;
  /** Tên + màu của profile đang kết nối (rỗng khi kết nối không đến từ profile nào). */
  profileName: string;
  profileColor: string;
  /** Môi trường của profile đang kết nối. Trường riêng, không suy từ màu. */
  profileEnv: ConnEnv;
  /** Đổi tên/màu/môi trường -> ghi thẳng vào profile trong localStorage (App.tsx làm việc đó). */
  onProfileChange: (patch: { name?: string; color?: string; env?: ConnEnv }) => void;
  onDisconnect: () => void;
  onReconnect: () => Promise<{ success: boolean; message?: string }>;
  onEdit: () => void;
  onClose: () => void;
}

// Bảng màu nhãn kết nối. Chuỗi rỗng = không gắn màu; giữ ở vị trí thứ hai cho
// khớp thứ tự của thiết kế (xanh lá trước, rồi ô trắng "bỏ màu").
const TAG_COLORS = [
  { value: '#86efac', labelKey: 'connInfo.colorGreen' },
  { value: '', labelKey: 'connInfo.colorNone' },
  { value: '#a5b4fc', labelKey: 'connInfo.colorBlue' },
  { value: '#fde68a', labelKey: 'connInfo.colorYellow' },
  { value: '#fca5a5', labelKey: 'connInfo.colorRed' },
] as const;

const DRIVER_LABELS: Record<string, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  redis: 'Redis',
};

const rowLabelStyle: React.CSSProperties = {
  fontSize: '11.5px',
  color: 'var(--win-text-secondary)',
  textAlign: 'right',
  whiteSpace: 'nowrap',
};

const rowValueStyle: React.CSSProperties = {
  fontSize: '11.5px',
  color: 'var(--win-text-primary)',
  fontFamily: 'var(--win-font-mono)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const cardStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '6px 12px',
  padding: '10px 12px',
  borderRadius: '8px',
  background: 'var(--win-bg-tab-bar)',
  border: '1px solid var(--win-border)',
};

const InfoRow: React.FC<{ label: string; value: string; title?: string }> = ({
  label,
  value,
  title,
}) => (
  <>
    <span style={rowLabelStyle}>{`${label}:`}</span>
    <span style={rowValueStyle} title={title || value}>{value}</span>
  </>
);

export const ConnectionInfoPopover: React.FC<ConnectionInfoPopoverProps> = ({
  anchor,
  status,
  profileName,
  profileColor,
  profileEnv,
  onProfileChange,
  onDisconnect,
  onReconnect,
  onEdit,
  onClose,
}) => {
  const { t } = useTranslation();
  const [name, setName] = useState(profileName);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const commitName = () => {
    const next = name.trim();
    if (next && next !== profileName) onProfileChange({ name: next });
  };

  const handleReconnect = async () => {
    setReconnecting(true);
    setReconnectError(null);
    const res = await onReconnect();
    setReconnecting(false);
    if (res.success) onClose();
    else setReconnectError(res.message || '');
  };

  const unknown = t('connInfo.unknown');
  const driverLabel = status?.dbType
    ? `${DRIVER_LABELS[status.dbType] || status.dbType} ${status.serverVersion}`.trim()
    : unknown;
  const hostLabel = status?.host
    ? status.port
      ? `${status.host}:${status.port}`
      : status.host
    : unknown;

  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 99998 }} onClick={onClose} />
      <div
        className="conn-info-popover"
        style={{
          position: 'fixed',
          top: `${anchor.top}px`,
          left: `${anchor.left}px`,
          width: '320px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          // --win-bg-popover, KHÔNG phải --win-bg-modal: biến đó chưa từng được khai báo
          // trong index.css nên nó luôn rơi về #ffffff, làm thẻ này trắng ở giao diện tối
          // và mọi nhãn --win-text-secondary bên trong thành gần như vô hình.
          background: 'var(--win-bg-popover)',
          border: '1px solid var(--win-border-strong)',
          borderRadius: '12px',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.35)',
          padding: '14px',
          zIndex: 99999,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tên kết nối + màu nhãn */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="text"
            className="form-input"
            value={name}
            placeholder={t('connInfo.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            style={{ flex: 1, minWidth: 0, height: '28px', fontSize: '12px', padding: '0 8px', borderRadius: '6px' }}
          />
          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
            {TAG_COLORS.map((c) => (
              <button
                key={c.labelKey}
                type="button"
                onClick={() => onProfileChange({ color: c.value })}
                title={t(c.labelKey)}
                aria-label={t(c.labelKey)}
                aria-pressed={profileColor === c.value}
                style={{
                  width: '20px',
                  height: '20px',
                  padding: 0,
                  borderRadius: '5px',
                  cursor: 'pointer',
                  // Ô "không màu" lấy đúng nền popover để nó đọc là trống, không phải trắng.
                  background: c.value || 'var(--win-bg-popover)',
                  border:
                    profileColor === c.value
                      ? '2px solid var(--win-accent)'
                      : '1px solid var(--win-border-strong)',
                }}
              />
            ))}
          </div>
        </div>

        {/* Môi trường. Ngay dưới tên + màu vì đó là bộ ba "kết nối này là cái gì", nhưng là ô riêng:
            màu bên trên thuần trang trí, còn ô này bật chỉ-đọc và xác nhận hai bước. */}
        <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)', flexShrink: 0 }}>
            {t('connEnv.label')}
          </span>
          <select
            className="form-input"
            value={profileEnv}
            onChange={(e) => onProfileChange({ env: normalizeEnv(e.target.value) })}
            style={{ flex: 1, minWidth: 0, height: '28px', fontSize: '12px', padding: '0 6px', borderRadius: '6px' }}
          >
            {CONN_ENVS.map((env) => (
              <option key={env} value={env}>{t(envLabelKey(env))}</option>
            ))}
          </select>
        </div>

        {/* Máy chủ */}
        <div style={cardStyle}>
          <InfoRow label={t('connInfo.server')} value={hostLabel} />
          <InfoRow label={t('connInfo.host')} value={status?.host || unknown} />
        </div>

        {/* Phiên hiện tại */}
        <div style={cardStyle}>
          <InfoRow label={t('connInfo.driver')} value={driverLabel} />
          <InfoRow label={t('connInfo.db')} value={status?.database || unknown} />
          <InfoRow label={t('connInfo.user')} value={status?.user || '—'} />
          <InfoRow
            label={t('connInfo.cipher')}
            value={status?.cipher || t('connInfo.notEncrypted')}
            title={status?.tlsVersion ? `${status.tlsVersion} · ${status.cipher}` : undefined}
          />
          <InfoRow label={t('connInfo.latency')} value={`${status?.latencyMs ?? 0} ms`} />
        </div>

        {reconnectError !== null && (
          <div style={{ fontSize: '11px', color: 'var(--st-err, #ef4444)' }}>
            {t('connInfo.reconnectFailed', { message: reconnectError })}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={onDisconnect} disabled={reconnecting}>
            {t('connInfo.disconnect')}
          </button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-secondary" onClick={handleReconnect} disabled={reconnecting}>
              {reconnecting ? t('connInfo.reconnecting') : t('connInfo.reconnect')}
            </button>
            <button
              className="btn btn-primary"
              onClick={onEdit}
              disabled={reconnecting}
              title={t('connInfo.editTitle')}
            >
              {t('connInfo.edit')}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
};
