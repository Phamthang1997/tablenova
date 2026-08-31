export type AiProviderType = 'openai' | 'gemini' | 'claude' | 'deepseek' | 'ollama' | 'custom';

export interface AiModelOption {
  id: string;
  label: string;
  badge?: string;
}

export interface AiAssistantProfile {
  id: string;
  name: string; // e.g. "Assistant 1"
  provider: AiProviderType;
  model: string; // e.g. "gpt-4o-mini", "deepseek-chat", "gemini-2.0-flash", "claude-3-7-sonnet"
  apiKey?: string;
  baseUrl?: string; // For Ollama or Custom OpenAI-compatible endpoints
  temperature?: number;
  maxTokens?: number;
  customSystemPrompt?: string;
  enabled?: boolean;
}

export interface AiSettings {
  activeProfileId: string;
  profiles: AiAssistantProfile[];
  googleClientId?: string;
  googleClientSecret?: string;
  googleAuthToken?: string;
  googleRefreshToken?: string;
  googleAuthEmail?: string;
  googleAuthExpiresAt?: number;
  autoAttachActiveTable: boolean;
  maxSchemaTokens: number;
}

export const PROVIDER_MODELS: Record<AiProviderType, AiModelOption[]> = {
  claude: [
    { id: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet (Hybrid Reasoning)', badge: 'Mới nhất 2025' },
    { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet v2', badge: 'Khuyên dùng' },
    { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Siêu tốc)', badge: 'Nhanh' },
    { id: 'claude-3-opus-20240229', label: 'Claude 3 Opus (Chuyên sâu)' },
  ],
  gemini: [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Cực nhanh & Miễn phí)', badge: 'Khuyên dùng' },
    { id: 'gemini-2.0-flash-thinking-exp-01-21', label: 'Gemini 2.0 Flash Thinking (Suy luận sâu)', badge: 'Mới' },
    { id: 'gemini-2.0-pro-exp-02-05', label: 'Gemini 2.0 Pro Experimental', badge: 'Mới' },
    { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (Context 2M tokens)' },
    { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'DeepSeek-V3 (deepseek-chat)', badge: 'Mới nhất' },
    { id: 'deepseek-reasoner', label: 'DeepSeek-R1 (deepseek-reasoner - Suy luận R1)', badge: 'Hot' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o (Đa năng mạnh nhất)' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini (Nhanh & Tiết kiệm)', badge: 'Phổ biến' },
    { id: 'o3-mini', label: 'o3-mini (Suy luận chuyên sâu mới)', badge: 'Mới' },
    { id: 'o1', label: 'o1 (Suy luận phức tạp)' },
    { id: 'o1-mini', label: 'o1-mini (Suy luận code nhanh)' },
    { id: 'gpt-4.5-preview', label: 'GPT-4.5 Preview', badge: 'Mới' },
  ],
  ollama: [
    { id: 'qwen2.5-coder:latest', label: 'Qwen 2.5 Coder (Chuyên SQL & Code)', badge: 'Tốt nhất' },
    { id: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B' },
    { id: 'qwen2.5-coder:32b', label: 'Qwen 2.5 Coder 32B' },
    { id: 'deepseek-r1:latest', label: 'DeepSeek R1 Local', badge: 'Hot' },
    { id: 'sqlcoder:latest', label: 'SQLCoder (Defog SQL Specialist)' },
    { id: 'llama3.3:latest', label: 'Llama 3.3 70B' },
    { id: 'llama3.1:8b', label: 'Llama 3.1 8B' },
  ],
  custom: [
    { id: 'anthropic/claude-3.7-sonnet', label: 'OpenRouter: Claude 3.7 Sonnet' },
    { id: 'deepseek/deepseek-r1', label: 'OpenRouter: DeepSeek R1' },
    { id: 'meta-llama/llama-3.3-70b-instruct', label: 'OpenRouter: Llama 3.3 70B' },
    { id: 'google/gemini-2.0-flash-001', label: 'OpenRouter: Gemini 2.0 Flash' },
  ],
};

export const PROVIDER_AUTH_URLS: Record<AiProviderType, { name: string; url: string; note: string }> = {
  gemini: {
    name: 'Google AI Studio',
    url: 'https://aistudio.google.com/app/apikey',
    note: 'Lấy API Key Google Gemini miễn phí 100% qua tài khoản Google',
  },
  deepseek: {
    name: 'DeepSeek Platform',
    url: 'https://platform.deepseek.com/api_keys',
    note: 'Lấy API Key DeepSeek V3 / R1 trực tiếp qua trình duyệt',
  },
  claude: {
    name: 'Anthropic Console',
    url: 'https://console.anthropic.com/settings/keys',
    note: 'Lấy API Key Claude 3.7 / 3.5 qua tài khoản Anthropic',
  },
  openai: {
    name: 'OpenAI Platform',
    url: 'https://platform.openai.com/api-keys',
    note: 'Lấy API Key GPT-4o / o3-mini qua tài khoản OpenAI',
  },
  ollama: {
    name: 'Ollama Official',
    url: 'https://ollama.com/library/qwen2.5-coder',
    note: 'Tải và chạy Qwen 2.5 Coder offline miễn phí 100% trên máy tính',
  },
  custom: {
    name: 'OpenRouter Platform',
    url: 'https://openrouter.ai/keys',
    note: 'Lấy API Key tổng hợp cho mọi LLM qua OpenRouter',
  },
};

const STORAGE_KEY = 'tablegrid_ai_settings_v1';

export const DEFAULT_AI_PROFILES: AiAssistantProfile[] = [
  {
    id: 'assistant-1',
    name: 'Assistant 1',
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    enabled: true,
  },
  {
    id: 'assistant-2',
    name: 'Assistant 2',
    provider: 'deepseek',
    model: 'deepseek-chat',
    temperature: 0.2,
    enabled: true,
  },
  {
    id: 'assistant-3',
    name: 'Assistant 3',
    provider: 'gemini',
    model: 'gemini-2.0-flash',
    temperature: 0.2,
    enabled: true,
  },
  {
    id: 'assistant-4',
    name: 'Claude 3.7',
    provider: 'claude',
    model: 'claude-3-7-sonnet-20250219',
    temperature: 0.2,
    enabled: true,
  },
  {
    id: 'assistant-5',
    name: 'Local SQL Coder',
    provider: 'ollama',
    model: 'qwen2.5-coder:latest',
    baseUrl: 'http://localhost:11434',
    temperature: 0.2,
    enabled: false,
  },
];

export const DEFAULT_AI_SETTINGS: AiSettings = {
  activeProfileId: 'assistant-1',
  profiles: DEFAULT_AI_PROFILES,
  autoAttachActiveTable: true,
  maxSchemaTokens: 4000,
};

export function getAiSettings(): AiSettings {
  if (typeof window === 'undefined') return DEFAULT_AI_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AI_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_AI_SETTINGS,
      ...parsed,
      profiles: parsed.profiles && parsed.profiles.length > 0 ? parsed.profiles : DEFAULT_AI_PROFILES,
    };
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
}

export function saveAiSettings(settings: AiSettings): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent('ai-settings-changed', { detail: settings }));
  } catch (err) {
    console.error('Failed to save AI settings:', err);
  }
}

export function getActiveProfile(): AiAssistantProfile {
  const settings = getAiSettings();
  const found = settings.profiles.find((p) => p.id === settings.activeProfileId);
  return found || settings.profiles[0] || DEFAULT_AI_PROFILES[0];
}

export function setActiveProfileId(profileId: string): void {
  const settings = getAiSettings();
  settings.activeProfileId = profileId;
  saveAiSettings(settings);
}
