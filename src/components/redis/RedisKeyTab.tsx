// Tab xem/sửa một key Redis.
//
// Phần trình bày giá trị vẫn là `ValuePanel` như cũ — file này chỉ là chỗ ở mới của nó: nạp key,
// giữ ba hộp thoại của riêng key (đổi tên / TTL / xoá), và dòng thông báo. Trước đây tất cả những
// thứ này nằm trong `RedisBrowser`, dùng chung cho cả workspace; giờ mỗi key là một tab nên chúng
// thuộc về tab.

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import { dbHelper, type RedisValueDetail } from '../../utils/dbHelper';
import { ConfirmDialog } from '../ConfirmDialog';
import { PromptDialog } from './PromptDialog';
import { ValuePanel } from './ValuePanel';
import { useRedisToast } from './useRedisToast';
import { notifyRedisKeysChanged } from './redisTabs';

interface RedisKeyTabProps {
  /** Kết nối của tab — cũng là db index, xem §2.1. */
  connId: string;
  keyName: string;
  /** localStorage scope cho tuỳ chọn hiển thị của ValuePanel — định danh SERVER, không phải dbName. */
  storageScope: string;
  readOnly: boolean;
  /** Key đã đổi tên -> tab phải mang tên mới. */
  onRenamed: (next: string) => void;
  /** Key không còn -> đóng tab (người dùng bấm nút trong trạng thái rỗng). */
  onClose: () => void;
}

export const RedisKeyTab: React.FC<RedisKeyTabProps> = ({
  connId,
  keyName,
  storageScope,
  readOnly,
  onRenamed,
  onClose,
}) => {
  const { t } = useTranslation();
  const { onError, onOk, blocked, node: toast } = useRedisToast(readOnly);

  const [detail, setDetail] = useState<RedisValueDetail | null>(null);
  // Ba trạng thái, không phải hai: `loading` khác `gone`. Gộp lại thì lần vẽ đầu tiên của một key
  // hoàn toàn bình thường cũng chớp qua thông báo "key không còn tồn tại".
  const [state, setState] = useState<'loading' | 'ready' | 'gone'>('loading');

  const [renaming, setRenaming] = useState(false);
  const [settingTtl, setSettingTtl] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    const d = await dbHelper.redisGetKey(keyName);
    if (!d.success) {
      // Key biến mất KHÔNG phải lỗi (§2.5): nó có thể đã hết TTL hoặc bị xoá từ chỗ khác giữa hai
      // phiên. Hiện trạng thái rỗng, không phải một dòng đỏ.
      setDetail(null);
      setState('gone');
      return;
    }
    setDetail(d);
    setState('ready');
  }, [keyName]);

  // `connId` nằm trong deps: cùng một tên key trên hai db index là hai key khác nhau, và tab được
  // dựng lại theo connId nên effect phải chạy lại cùng nó.
  useEffect(() => { void load(); }, [load, connId]);

  const doRename = async (next: string) => {
    setRenaming(false);
    if (!next.trim() || next === keyName || blocked()) return;
    const res = await dbHelper.redisRenameKey(keyName, next);
    if (!res.success) { onError(res.error || t('redis.errRename')); return; }
    notifyRedisKeysChanged({ connId, removed: keyName, renamedTo: next });
    onRenamed(next);
  };

  const doSetTtl = async (raw: string) => {
    setSettingTtl(false);
    if (blocked()) return;
    const ttl = parseInt(raw, 10);
    if (Number.isNaN(ttl)) { onError(t('redis.errTtlNotNumber')); return; }
    const res = await dbHelper.redisSetTtl(keyName, ttl);
    if (!res.success) { onError(res.error || t('redis.errTtl')); return; }
    onOk(t('redis.ttlSet'));
    void load();
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    if (blocked()) return;
    const res = await dbHelper.redisDeleteKeys([keyName]);
    if (!res.success) { onError(res.error || t('redis.errDelete')); return; }
    notifyRedisKeysChanged({ connId, removed: keyName });
    setDetail(null);
    setState('gone');
  };

  return (
    <div className="redis-tab">
      {toast}
      <div className="redis-tab-body">
        {state === 'loading' ? null : state === 'gone' ? (
          <div className="redis-empty">
            <KeyRound size={22} />
            <div className="redis-empty-title">{t('redis.keyGone', { key: keyName })}</div>
            <div className="redis-empty-hint">{t('redis.keyGoneHint')}</div>
            <div className="redis-empty-actions">
              <button className="btn btn-secondary" onClick={() => { setState('loading'); void load(); }}>
                {t('redis.retry')}
              </button>
              <button className="btn btn-secondary" onClick={onClose}>{t('redis.closeTab')}</button>
            </div>
          </div>
        ) : detail ? (
          <ValuePanel
            detail={detail}
            storageScope={storageScope}
            readOnly={readOnly}
            onRename={() => setRenaming(true)}
            onSetTtl={() => setSettingTtl(true)}
            onDelete={() => setConfirmDelete(true)}
            onError={onError}
            onOk={onOk}
            onBlocked={blocked}
            onReload={load}
          />
        ) : null}
      </div>

      <PromptDialog
        open={renaming}
        title={t('redis.rename')}
        label={t('redis.promptRename')}
        defaultValue={keyName}
        onSubmit={doRename}
        onCancel={() => setRenaming(false)}
      />
      <PromptDialog
        open={settingTtl}
        title={t('redis.ttlTitle')}
        label={t('redis.promptTtl')}
        defaultValue={String(detail?.ttl ?? -1)}
        note={t('redis.promptTtlNote')}
        onSubmit={doSetTtl}
        onCancel={() => setSettingTtl(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={t('redis.delete')}
        message={t('redis.confirmDeleteKey', { key: keyName })}
        danger
        confirmLabel={t('redis.delete')}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
};
