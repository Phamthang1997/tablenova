import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, CornerDownLeft, Play, AlertCircle } from 'lucide-react';
import { AiProviderIcon } from './AiIcons';
import type { AiChatMessage } from '../../utils/aiSessions';
import type { AiProviderType } from '../../utils/aiConfig';

interface AiMessageItemProps {
  message: AiChatMessage;
  provider?: AiProviderType;
  onInsertSql?: (sql: string) => void;
  onRunSql?: (sql: string) => void;
}

export const AiMessageItem: React.FC<AiMessageItemProps> = ({
  message,
  provider = 'openai',
  onInsertSql,
  onRunSql,
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatTime = useCallback((ts: number) => {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return t('ai.justNow', 'Just Now');
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [t]);

  // Render text with backticks highlighted as tags (like `film`, `category`)
  const renderFormattedText = (rawText: string) => {
    // Remove the ```sql ... ``` block from text if extracted separately
    let cleanText = rawText.replace(/```(?:sql|SQL)?\s*[\s\S]*?```/g, '').trim();
    if (!cleanText && message.sql) return null;

    const parts = cleanText.split(/(`[^`]+`)/g);

    return (
      <div className="ai-message-body-text">
        {parts.map((part, idx) => {
          if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
            const token = part.slice(1, -1);
            return (
              <span key={idx} className="ai-inline-tag">
                {token}
              </span>
            );
          }
          return <span key={idx}>{part}</span>;
        })}
      </div>
    );
  };

  if (message.sender === 'user') {
    return (
      <div className="ai-message-row user">
        <div className="ai-message-bubble user">
          <div className="ai-user-text">{message.text}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`ai-message-row assistant ${message.error ? 'error' : ''}`}>
      {/* Header with Assistant icon & name */}
      <div className="ai-assistant-header">
        <div className="ai-assistant-avatar">
          <AiProviderIcon provider={provider} size={14} />
        </div>
        <span className="ai-assistant-name">{message.assistantName || 'Assistant 1'}</span>
        <span className="ai-assistant-time">{formatTime(message.timestamp)}</span>
      </div>

      <div className="ai-message-bubble assistant">
        {message.error && (
          <div className="ai-error-banner">
            <AlertCircle size={14} className="ai-error-icon" />
            <span>{message.text}</span>
          </div>
        )}

        {!message.error && renderFormattedText(message.text)}

        {message.sql && (
          <div className="ai-code-wrapper">
            <div className="ai-code-header">
              <span className="ai-code-lang">sql</span>
              <div className="ai-code-actions">
                <button
                  className="ai-code-action-btn"
                  onClick={() => handleCopy(message.sql || '')}
                  title={t('common.copy', 'Copy SQL')}
                >
                  {copied ? <Check size={13} className="ai-check-icon" /> : <Copy size={13} />}
                  <span>{copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}</span>
                </button>

                {onInsertSql && (
                  <button
                    className="ai-code-action-btn"
                    onClick={() => onInsertSql(message.sql || '')}
                    title={t('ai.insertIntoEditor', 'Insert into Editor')}
                  >
                    <CornerDownLeft size={13} />
                    <span>{t('ai.insert', 'Insert')}</span>
                  </button>
                )}

                {onRunSql && (
                  <button
                    className="ai-code-action-btn primary"
                    onClick={() => onRunSql(message.sql || '')}
                    title={t('ai.runQuery', 'Run Query')}
                  >
                    <Play size={13} />
                    <span>{t('ai.run', 'Run')}</span>
                  </button>
                )}
              </div>
            </div>

            <pre className="ai-sql-pre">
              <code className="ai-sql-code">{message.sql}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
