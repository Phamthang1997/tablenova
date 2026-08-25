import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, ChevronDown, Sparkles, MoreHorizontal, Send, Plus, Loader2 } from 'lucide-react';
import { AiProviderIcon } from './AiIcons';
import { AiMessageItem } from './AiMessageItem';
import { AiCompareSection } from './AiCompareSection';
import { AiContextPicker } from './AiContextPicker';
import { AiModelSelector } from './AiModelSelector';
import { AiSessionDrawer } from './AiSessionDrawer';
import { AiSettingsModal } from './AiSettingsModal';
import {
  getAiSettings,
  saveAiSettings,
} from '../../utils/aiConfig';
import type {
  AiAssistantProfile,
  AiSettings,
} from '../../utils/aiConfig';
import {
  getAiSessions,
  getActiveSessionId,
  setActiveSessionId,
  createNewSession,
  deleteSession,
  renameSession,
  updateSessionMessages,
  updateSessionTables,
} from '../../utils/aiSessions';
import type {
  AiChatSession,
  AiChatMessage,
} from '../../utils/aiSessions';
import { buildSchemaContext, buildSystemPrompt } from '../../utils/aiContextBuilder';
import { sendAiChat } from '../../utils/aiService';

interface AiAssistantProps {
  onInsertSql: (sql: string) => void;
  onRunSql?: (sql: string) => void;
  tableNameContext?: string | null;
  dbType?: string;
  onClose?: () => void;
}

export const AiAssistant: React.FC<AiAssistantProps> = ({
  onInsertSql,
  onRunSql,
  tableNameContext,
  dbType = 'sql',
}) => {
  const { t } = useTranslation();

  // Settings & Profiles state
  const [settings, setSettings] = useState<AiSettings>(() => getAiSettings());
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showSessionDrawer, setShowSessionDrawer] = useState(false);
  const [showMenuDropdown, setShowMenuDropdown] = useState(false);

  // Sessions state
  const [sessions, setSessions] = useState<AiChatSession[]>(() => getAiSessions());
  const [activeSessionId, setActiveId] = useState<string>(() => getActiveSessionId());

  // Input & Streaming state
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Active Session
  const activeSession =
    sessions.find((s) => s.id === activeSessionId) || sessions[0] || createNewSession('Chat 1');

  // Active Profile
  const activeProfile =
    settings.profiles.find((p) => p.id === settings.activeProfileId) ||
    settings.profiles[0];

  // Auto-attach current active table if setting is on and session has no tables yet
  useEffect(() => {
    if (tableNameContext && activeSession.attachedTables.length === 0) {
      queueMicrotask(() => {
        updateSessionTables(activeSession.id, [tableNameContext]);
        setSessions(getAiSessions());
      });
    }
  }, [tableNameContext, activeSession.id, activeSession.attachedTables.length]);

  // Sync settings when changed from other places
  useEffect(() => {
    const handleSettingsChanged = () => setSettings(getAiSettings());
    const handleSessionsChanged = () => setSessions(getAiSessions());
    const handleActiveChanged = (e: any) => setActiveId(e.detail || getActiveSessionId());

    window.addEventListener('ai-settings-changed', handleSettingsChanged);
    window.addEventListener('ai-sessions-changed', handleSessionsChanged);
    window.addEventListener('ai-active-session-changed', handleActiveChanged);
    return () => {
      window.removeEventListener('ai-settings-changed', handleSettingsChanged);
      window.removeEventListener('ai-sessions-changed', handleSessionsChanged);
      window.removeEventListener('ai-active-session-changed', handleActiveChanged);
    };
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeSession.messages, streamingText, loading]);

  const handleSelectSession = (id: string) => {
    setActiveId(id);
    setActiveSessionId(id);
  };

  const handleCreateNewSession = () => {
    const newS = createNewSession();
    setSessions(getAiSessions());
    setActiveId(newS.id);
    setShowSessionDrawer(false);
  };

  const handleDeleteSession = (id: string) => {
    deleteSession(id);
    setSessions(getAiSessions());
    setActiveId(getActiveSessionId());
  };

  const handleRenameSession = (id: string, title: string) => {
    renameSession(id, title);
    setSessions(getAiSessions());
  };

  const handleAddTableToContext = (tbl: string) => {
    if (!activeSession.attachedTables.includes(tbl)) {
      const updated = [...activeSession.attachedTables, tbl];
      updateSessionTables(activeSession.id, updated);
      setSessions(getAiSessions());
    }
  };

  const handleRemoveTableFromContext = (tbl: string) => {
    const updated = activeSession.attachedTables.filter((t) => t !== tbl);
    updateSessionTables(activeSession.id, updated);
    setSessions(getAiSessions());
  };

  const handleSendPrompt = async (promptText: string, targetProfile = activeProfile) => {
    if (!promptText.trim() || loading) return;

    const userMsg: AiChatMessage = {
      id: `msg-${Date.now()}-user`,
      sender: 'user',
      text: promptText,
      timestamp: Date.now(),
    };

    const updatedMessages = [...activeSession.messages, userMsg];
    updateSessionMessages(activeSession.id, updatedMessages);
    setSessions(getAiSessions());
    setInputValue('');
    setLoading(true);
    setStreamingText('');

    try {
      // Build real-time database schema context
      const schemaContext = await buildSchemaContext({
        activeTable: tableNameContext,
        attachedTables: activeSession.attachedTables,
        dbType,
      });

      const systemPrompt = buildSystemPrompt(schemaContext, targetProfile.customSystemPrompt);

      // Build history for conversational context
      const history = activeSession.messages.slice(-6).map((m) => ({
        role: (m.sender === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.text,
      }));

      const res = await sendAiChat({
        profile: targetProfile,
        systemPrompt,
        userPrompt: promptText,
        history,
        onChunk: (chunk) => {
          setStreamingText(chunk);
        },
      });

      const assistantMsg: AiChatMessage = {
        id: `msg-${Date.now()}-asst`,
        sender: 'assistant',
        assistantId: targetProfile.id,
        assistantName: targetProfile.name,
        model: targetProfile.model,
        text: res.text,
        sql: res.sql,
        timestamp: Date.now(),
        error: !!res.error,
      };

      const finalMessages = [...updatedMessages, assistantMsg];
      updateSessionMessages(activeSession.id, finalMessages);
      setSessions(getAiSessions());
    } catch (err: any) {
      const errorMsg: AiChatMessage = {
        id: `msg-${Date.now()}-err`,
        sender: 'assistant',
        assistantId: targetProfile.id,
        assistantName: targetProfile.name,
        model: targetProfile.model,
        text: `Lỗi kết nối AI: ${err?.message || String(err)}`,
        timestamp: Date.now(),
        error: true,
      };
      updateSessionMessages(activeSession.id, [...updatedMessages, errorMsg]);
      setSessions(getAiSessions());
    } finally {
      setLoading(false);
      setStreamingText('');
    }
  };

  const handleCompareWith = (compareProfile: AiAssistantProfile) => {
    // Find the last user prompt in session
    const lastUserMsg = [...activeSession.messages].reverse().find((m) => m.sender === 'user');
    if (!lastUserMsg) return;
    handleSendPrompt(lastUserMsg.text, compareProfile);
  };

  const handleClearMessages = () => {
    updateSessionMessages(activeSession.id, []);
    setSessions(getAiSessions());
    setShowMenuDropdown(false);
  };

  return (
    <div className="ai-panel">
      {/* Top Header Bar */}
      <div className="ai-panel-header">
        <div className="ai-header-left">
          <button
            className="ai-header-icon-btn"
            onClick={() => setShowSessionDrawer(true)}
            title={t('ai.chatHistory', 'Lịch sử đoạn chat')}
          >
            <Menu size={15} />
          </button>

          <div className="ai-header-divider" />

          {/* Session Selector Dropdown */}
          <button
            className="ai-header-session-btn"
            onClick={() => setShowSessionDrawer(true)}
          >
            <div className="ai-header-session-icon">
              <AiProviderIcon provider={activeProfile.provider} size={14} />
            </div>
            <span className="ai-header-session-title">{activeSession.title}</span>
            <ChevronDown size={12} className="ai-header-chevron" />
          </button>
        </div>

        <div className="ai-header-right">
          <button
            className="ai-header-icon-btn"
            onClick={handleCreateNewSession}
            title={t('ai.newChat', 'Tạo đoạn chat mới')}
          >
            <Sparkles size={14} />
          </button>

          <div className="ai-header-more-wrapper">
            <button
              className="ai-header-icon-btn"
              onClick={() => setShowMenuDropdown((prev) => !prev)}
              title={t('common.more', 'Tùy chọn khác')}
            >
              <MoreHorizontal size={15} />
            </button>

            {showMenuDropdown && (
              <div className="ai-header-menu-dropdown">
                <button
                  className="ai-header-menu-item"
                  onClick={() => {
                    setShowMenuDropdown(false);
                    setShowSettingsModal(true);
                  }}
                >
                  ⚙️ Cài đặt AI & API Keys...
                </button>
                <button
                  className="ai-header-menu-item"
                  onClick={handleClearMessages}
                >
                  🗑️ Xóa tin nhắn cuộc trò chuyện này
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="ai-messages-container">
        {activeSession.messages.length === 0 && (
          <div className="ai-empty-welcome-box">
            <div className="ai-welcome-avatar">
              <AiProviderIcon provider={activeProfile.provider} size={24} />
            </div>
            <div className="ai-welcome-title">{activeProfile.name}</div>
            <div className="ai-welcome-desc">
              Trợ lý AI hỗ trợ viết, giải thích và tối ưu truy vấn SQL thông minh dựa trên cấu trúc CSDL hiện tại.
            </div>

            <div className="ai-quick-prompts-label">Gợi ý câu hỏi nhanh:</div>
            <div className="ai-quick-prompts-list">
              <button
                className="ai-quick-prompt-chip"
                onClick={() =>
                  handleSendPrompt(
                    tableNameContext
                      ? `Lấy danh sách 10 bản ghi mới nhất từ bảng ${tableNameContext}`
                      : 'Hiển thị danh sách tất cả các bảng và số lượng bản ghi tương ứng'
                  )
                }
              >
                📊 {tableNameContext ? `Top 10 bản ghi bảng ${tableNameContext}` : 'Thống kê tổng quan các bảng'}
              </button>

              <button
                className="ai-quick-prompt-chip"
                onClick={() =>
                  handleSendPrompt(
                    tableNameContext
                      ? `Tìm các bản ghi trùng lặp và tối ưu hóa index cho bảng ${tableNameContext}`
                      : 'Đề xuất cách tối ưu hóa truy vấn JOIN trong cơ sở dữ liệu'
                  )
                }
              >
                ⚡ {tableNameContext ? `Tối ưu & Tìm trùng bảng ${tableNameContext}` : 'Gợi ý tối ưu hiệu năng SQL'}
              </button>

              <button
                className="ai-quick-prompt-chip"
                onClick={() =>
                  handleSendPrompt(
                    tableNameContext
                      ? `Viết câu lệnh INSERT 5 dòng dữ liệu mẫu (mock data) cho bảng ${tableNameContext}`
                      : 'Viết câu lệnh tạo dữ liệu mẫu cho các bảng'
                  )
                }
              >
                📝 {tableNameContext ? `Tạo 5 dòng dữ liệu mẫu bảng ${tableNameContext}` : 'Tạo dữ liệu mẫu'}
              </button>
            </div>
          </div>
        )}

        {activeSession.messages.map((msg) => (
          <AiMessageItem
            key={msg.id}
            message={msg}
            provider={activeProfile.provider}
            onInsertSql={onInsertSql}
            onRunSql={onRunSql}
          />
        ))}

        {/* Live Streaming Message Indicator */}
        {loading && streamingText && (
          <AiMessageItem
            message={{
              id: 'streaming-temp',
              sender: 'assistant',
              assistantName: activeProfile.name,
              model: activeProfile.model,
              text: streamingText,
              timestamp: 0,
            }}
            provider={activeProfile.provider}
            onInsertSql={onInsertSql}
            onRunSql={onRunSql}
          />
        )}

        {/* Thinking Indicator */}
        {loading && !streamingText && (
          <div className="ai-message-row assistant">
            <div className="ai-assistant-header">
              <div className="ai-assistant-avatar">
                <AiProviderIcon provider={activeProfile.provider} size={14} />
              </div>
              <span className="ai-assistant-name">{activeProfile.name}</span>
            </div>
            <div className="ai-message-bubble assistant thinking">
              <Loader2 size={14} className="ai-spinning" />
              <span>{t('ai.thinking', 'Đang phân tích schema & viết SQL...')}</span>
            </div>
          </div>
        )}

        {/* "You can compare this answer with..." */}
        {!loading && activeSession.messages.length > 0 && (
          <AiCompareSection
            currentAssistantId={activeProfile.id}
            profiles={settings.profiles}
            onCompareWith={handleCompareWith}
            loading={loading}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom Composite Smart Input Box */}
      <div className="ai-input-card-container">
        <div className="ai-input-card">
          <textarea
            ref={textareaRef}
            className="ai-textarea"
            placeholder={t('ai.inputPlaceholder', 'Ask AI Assistant...')}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendPrompt(inputValue);
              }
            }}
            rows={2}
          />

          {/* Context Pills (Attached Tables) */}
          <AiContextPicker
            attachedTables={activeSession.attachedTables}
            onAddTable={handleAddTableToContext}
            onRemoveTable={handleRemoveTableFromContext}
          />

          {/* Bottom Bar: Model Selector + Attach Plus + Send Button */}
          <div className="ai-input-bottom-row">
            <AiModelSelector
              activeProfile={activeProfile}
              profiles={settings.profiles}
              onSelectProfile={(p) => {
                const newSettings = { ...settings, activeProfileId: p.id };
                setSettings(newSettings);
                saveAiSettings(newSettings);
              }}
              onOpenSettings={() => setShowSettingsModal(true)}
            />

            <div className="ai-input-actions-right">
              <button
                className="ai-input-add-prompt-btn"
                onClick={() => setShowSettingsModal(true)}
                title="Cài đặt AI & API"
                type="button"
              >
                <Plus size={14} />
              </button>

              <button
                className="ai-send-btn"
                onClick={() => handleSendPrompt(inputValue)}
                disabled={loading || !inputValue.trim()}
                type="button"
                title="Gửi câu hỏi"
              >
                {loading ? <Loader2 size={14} className="ai-spinning" /> : <Send size={14} />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Session History Drawer */}
      {showSessionDrawer && (
        <AiSessionDrawer
          sessions={sessions}
          activeSessionId={activeSession.id}
          onSelectSession={handleSelectSession}
          onCreateSession={handleCreateNewSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onClose={() => setShowSessionDrawer(false)}
        />
      )}

      {/* Settings Modal */}
      <AiSettingsModal
        open={showSettingsModal}
        onClose={() => {
          setShowSettingsModal(false);
          setSettings(getAiSettings());
        }}
      />
    </div>
  );
};
