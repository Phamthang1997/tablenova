import React, { useState, useRef, useEffect } from 'react';
import { dbHelper } from '../utils/dbHelper';
import { Send, Bot, User, Copy, CornerDownLeft } from 'lucide-react';

interface ChatMessage {
  sender: 'user' | 'assistant';
  text: string;
  sql?: string;
}

interface AiAssistantProps {
  onInsertSql: (sql: string) => void;
  tableNameContext?: string | null;
}

export const AiAssistant: React.FC<AiAssistantProps> = ({ onInsertSql, tableNameContext }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      sender: 'assistant',
      text: 'Xin chào! Tôi là Trợ lý AI hỗ trợ SQL của TableNova. Tôi có thể dịch câu hỏi tiếng Việt của bạn thành truy vấn SQL tương ứng.\n\nHãy thử hỏi tôi: *"lấy danh sách admin hoạt động trong bảng users"* hoặc *"tổng doanh thu của tất cả đơn hàng"*!',
    },
  ]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!inputValue.trim()) return;

    const userText = inputValue;
    setMessages((prev) => [...prev, { sender: 'user', text: userText }]);
    setInputValue('');
    setLoading(true);

    const schemaContext = tableNameContext 
      ? `Bảng hiện tại: ${tableNameContext}. Bảng khác: users, products, orders`
      : 'Các bảng hiện có: users (id, full_name, email, role, status, created_at), products (id, name, price, stock, category), orders (id, user_id, product_id, quantity, total_amount, order_date)';

    const res = await dbHelper.askAi(userText, schemaContext);
    setLoading(false);

    // Extract SQL if returned
    let sql: string | undefined;
    
    // Standard mock API parsing
    // In our backend main.js, /api/ai-chat returns { response: "...", sql: "..." }
    const resData = res as any;
    if (resData.sql) {
      sql = resData.sql;
    }

    setMessages((prev) => [
      ...prev,
      {
        sender: 'assistant',
        text: resData.response || res.response,
        sql,
      },
    ]);
  };

  const handleCopy = (sql: string) => {
    navigator.clipboard.writeText(sql);
  };

  return (
    <div className="ai-panel">
      <div className="ai-panel-header">
        <Bot size={16} />
        <span>Trợ lý AI</span>
      </div>

      <div className="ai-messages-container">
        {messages.map((msg, i) => (
          <div key={i} className={`ai-message ${msg.sender}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', opacity: 0.8 }}>
              {msg.sender === 'assistant' ? <Bot size={13} /> : <User size={13} />}
              <span style={{ fontSize: '10px', fontWeight: 600 }}>
                {msg.sender === 'assistant' ? 'Trợ lý AI' : 'Bạn'}
              </span>
            </div>
            
            <div style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
            
            {msg.sql && (
              <div>
                <pre className="ai-code-block">
                  <code>{msg.sql}</code>
                </pre>
                <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                  <button
                    className="ai-action-btn"
                    onClick={() => onInsertSql(msg.sql || '')}
                    style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                  >
                    <CornerDownLeft size={10} />
                    <span>Nạp vào editor</span>
                  </button>
                  <button
                    className="ai-action-btn"
                    onClick={() => handleCopy(msg.sql || '')}
                    style={{ background: 'transparent', border: '1px solid var(--win-border-strong)', color: '#fff', display: 'flex', alignItems: 'center', gap: '4px' }}
                  >
                    <Copy size={10} />
                    <span>Sao chép</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="ai-message assistant">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', opacity: 0.8 }}>
              <Bot size={13} />
              <span style={{ fontSize: '10px' }}>Đang nghĩ...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="ai-input-container">
        <textarea
          className="ai-textarea"
          placeholder="Hỏi AI viết SQL (nhấn Enter)..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button className="ai-send-btn" onClick={handleSend} disabled={loading}>
          <Send size={14} />
        </button>
      </div>
    </div>
  );
};
