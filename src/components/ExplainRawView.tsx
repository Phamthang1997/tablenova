import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface ExplainRawViewProps {
  rawText: string;
}

export const ExplainRawView: React.FC<ExplainRawViewProps> = ({ rawText }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(rawText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--win-bg-window)',
      position: 'relative'
    }}>
      {/* Copy Toolbar */}
      <div style={{
        display: 'flex',
        justifyContent: 'flex-end',
        padding: '8px 12px',
        background: 'var(--win-bg-card)',
        borderBottom: '1px solid var(--win-border)'
      }}>
        <button
          className="btn btn-secondary"
          onClick={handleCopy}
          style={{ padding: '4px 10px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          {copied ? <Check size={13} style={{ color: 'var(--st-ok)' }} /> : <Copy size={13} />}
          <span>{copied ? 'Đã sao chép!' : 'Sao chép văn bản (Copy Raw)'}</span>
        </button>
      </div>

      {/* Raw Monospace Text View */}
      <pre style={{
        flex: 1,
        margin: 0,
        padding: '16px',
        fontFamily: 'var(--win-font-mono)',
        fontSize: '12px',
        color: 'var(--win-text-primary)',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all'
      }}>
        {rawText}
      </pre>
    </div>
  );
};
