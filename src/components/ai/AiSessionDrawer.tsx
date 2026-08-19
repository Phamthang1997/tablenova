import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, MessageSquare, Trash2, Edit2, Check, X } from 'lucide-react';
import type { AiChatSession } from '../../utils/aiSessions';

interface AiSessionDrawerProps {
  sessions: AiChatSession[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, newTitle: string) => void;
  onClose: () => void;
}

export const AiSessionDrawer: React.FC<AiSessionDrawerProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onRenameSession,
  onClose,
}) => {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const startRename = (s: AiChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(s.id);
    setEditTitle(s.title);
  };

  const saveRename = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (editTitle.trim()) {
      onRenameSession(id, editTitle.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="ai-session-drawer-backdrop" onClick={onClose}>
      <div className="ai-session-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ai-session-drawer-header">
          <span className="ai-session-drawer-title">{t('ai.chatHistory', 'Lịch sử đoạn chat')}</span>
          <button className="ai-session-new-btn" onClick={onCreateSession}>
            <Plus size={13} />
            <span>{t('ai.newChat', 'Đoạn chat mới')}</span>
          </button>
        </div>

        <div className="ai-session-list">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const isEditing = session.id === editingId;

            return (
              <div
                key={session.id}
                className={`ai-session-item ${isActive ? 'active' : ''}`}
                onClick={() => {
                  if (!isEditing) {
                    onSelectSession(session.id);
                    onClose();
                  }
                }}
              >
                <MessageSquare size={13} className="ai-session-item-icon" />

                {isEditing ? (
                  <div className="ai-session-edit-box" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="text"
                      className="ai-session-edit-input"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRename(session.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      autoFocus
                    />
                    <button className="ai-session-action-btn" onClick={(e) => saveRename(session.id, e)}>
                      <Check size={11} />
                    </button>
                    <button className="ai-session-action-btn" onClick={() => setEditingId(null)}>
                      <X size={11} />
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="ai-session-item-name">{session.title}</span>
                    <div className="ai-session-item-actions">
                      <button
                        className="ai-session-action-btn"
                        onClick={(e) => startRename(session, e)}
                        title={t('common.rename', 'Đổi tên')}
                      >
                        <Edit2 size={11} />
                      </button>
                      <button
                        className="ai-session-action-btn danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(session.id);
                        }}
                        title={t('common.delete', 'Xóa')}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
