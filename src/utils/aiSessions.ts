export interface AiChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  assistantId?: string;
  assistantName?: string;
  model?: string;
  text: string;
  sql?: string;
  timestamp: number;
  error?: boolean;
  comparedFromId?: string; // id of parent message if this was generated from comparison
}

export interface AiChatSession {
  id: string;
  title: string;
  messages: AiChatMessage[];
  attachedTables: string[];
  createdAt: number;
  updatedAt: number;
}

const SESSIONS_STORAGE_KEY = 'tablenova_ai_sessions_v1';
const ACTIVE_SESSION_KEY = 'tablenova_ai_active_session_id';

export function getAiSessions(): AiChatSession[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!raw) {
      const initialSession = createDefaultSession();
      saveAiSessions([initialSession]);
      return [initialSession];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      const initialSession = createDefaultSession();
      saveAiSessions([initialSession]);
      return [initialSession];
    }
    return parsed;
  } catch {
    return [createDefaultSession()];
  }
}

export function saveAiSessions(sessions: AiChatSession[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    window.dispatchEvent(new CustomEvent('ai-sessions-changed'));
  } catch (err) {
    console.error('Failed to save AI sessions:', err);
  }
}

export function getActiveSessionId(): string {
  if (typeof window === 'undefined') return 'session-1';
  return localStorage.getItem(ACTIVE_SESSION_KEY) || 'session-1';
}

export function setActiveSessionId(sessionId: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
  window.dispatchEvent(new CustomEvent('ai-active-session-changed', { detail: sessionId }));
}

export function createDefaultSession(title = 'Chat 1'): AiChatSession {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `session-${crypto.randomUUID()}`
      : `session-${Date.now()}`;
  return {
    id,
    title,
    messages: [],
    attachedTables: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function createNewSession(title?: string): AiChatSession {
  const sessions = getAiSessions();
  const index = sessions.length + 1;
  const sessionName = title || `Chat ${index}`;
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `session-${crypto.randomUUID()}`
      : `session-${Date.now()}`;
  const newSession: AiChatSession = {
    id,
    title: sessionName,
    messages: [],
    attachedTables: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveAiSessions([newSession, ...sessions]);
  setActiveSessionId(newSession.id);
  return newSession;
}

export function deleteSession(sessionId: string): void {
  const sessions = getAiSessions().filter((s) => s.id !== sessionId);
  if (sessions.length === 0) {
    const fallback = createDefaultSession('Chat 1');
    saveAiSessions([fallback]);
    setActiveSessionId(fallback.id);
  } else {
    saveAiSessions(sessions);
    if (getActiveSessionId() === sessionId) {
      setActiveSessionId(sessions[0].id);
    }
  }
}

export function renameSession(sessionId: string, newTitle: string): void {
  const sessions = getAiSessions().map((s) =>
    s.id === sessionId ? { ...s, title: newTitle.trim() || s.title, updatedAt: Date.now() } : s
  );
  saveAiSessions(sessions);
}

export function updateSessionMessages(sessionId: string, messages: AiChatMessage[]): void {
  const sessions = getAiSessions().map((s) =>
    s.id === sessionId ? { ...s, messages, updatedAt: Date.now() } : s
  );
  saveAiSessions(sessions);
}

export function updateSessionTables(sessionId: string, attachedTables: string[]): void {
  const sessions = getAiSessions().map((s) =>
    s.id === sessionId ? { ...s, attachedTables, updatedAt: Date.now() } : s
  );
  saveAiSessions(sessions);
}
