import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { TerminalWindow } from './TerminalWindow.tsx'

// Nếu mở dưới dạng cửa sổ Terminal riêng (?term=...) thì render root chỉ có Terminal.
const termParam = new URLSearchParams(window.location.search).get('term');

// Tắt menu chuột phải mặc định của webview (ngoại trừ trên input, textarea và Monaco Editor)
document.addEventListener('contextmenu', (e) => {
  const target = e.target as HTMLElement;
  if (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.closest('.monaco-editor') ||
    target.isContentEditable
  ) {
    return;
  }
  e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {termParam ? <TerminalWindow raw={termParam} /> : <App />}
  </StrictMode>,
)
