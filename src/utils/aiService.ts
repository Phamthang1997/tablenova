import type { AiAssistantProfile } from './aiConfig';
import { extractSqlFromText } from './aiContextBuilder';
import { getGoogleAuthState } from './aiAuth';

export interface AiChatRequest {
  profile: AiAssistantProfile;
  systemPrompt: string;
  userPrompt: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  onChunk?: (chunkText: string) => void;
  signal?: AbortSignal;
}

export interface AiChatResponse {
  text: string;
  sql?: string;
  error?: string;
}

export interface LiveModelItem {
  id: string;
  label: string;
  badge?: string;
}

export async function sendAiChat(request: AiChatRequest): Promise<AiChatResponse> {
  const { profile } = request;

  try {
    switch (profile.provider) {
      case 'openai':
      case 'deepseek':
      case 'custom':
        return await callOpenAiCompatible(request);
      case 'gemini':
        return await callGemini(request);
      case 'claude':
        return await callClaude(request);
      case 'ollama':
        return await callOllama(request);
      default:
        return await callOpenAiCompatible(request);
    }
  } catch (err: any) {
    console.error('AI Service Error:', err);
    return {
      text: `Lỗi kết nối AI: ${err?.message || String(err)}`,
      error: err?.message || String(err),
    };
  }
}

async function callOpenAiCompatible(req: AiChatRequest): Promise<AiChatResponse> {
  const { profile, systemPrompt, userPrompt, history = [], onChunk, signal } = req;
  
  let baseUrl = profile.baseUrl || 'https://api.openai.com/v1';
  if (profile.provider === 'deepseek' && !profile.baseUrl) {
    baseUrl = 'https://api.deepseek.com/v1';
  }
  baseUrl = baseUrl.replace(/\/+$/, '');

  const apiKey = profile.apiKey || '';
  if (!apiKey && profile.provider !== 'custom') {
    throw new Error(`Chưa cấu hình API Key cho ${profile.name}. Hãy vào Cài đặt (⋯) để thêm API Key.`);
  }

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];

  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: userPrompt });

  const isStreaming = typeof onChunk === 'function';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: profile.model || (profile.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'),
      messages,
      temperature: profile.temperature ?? 0.2,
      stream: isStreaming,
    }),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API Error (${response.status}): ${errorBody}`);
  }

  if (isStreaming && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullText += delta;
              onChunk(fullText);
            }
          } catch {
            // Ignore partial json parse error
          }
        }
      }
    }

    const sql = extractSqlFromText(fullText);
    return { text: fullText, sql };
  } else {
    const data = await response.json();
    const fullText = data.choices?.[0]?.message?.content || '';
    const sql = extractSqlFromText(fullText);
    return { text: fullText, sql };
  }
}

async function callGemini(req: AiChatRequest): Promise<AiChatResponse> {
  const { profile, systemPrompt, userPrompt, history = [], onChunk, signal } = req;
  const apiKey = profile.apiKey || '';
  const authState = getGoogleAuthState();
  const oauthToken = !apiKey && authState.isLoggedIn ? authState.accessToken : '';

  if (!apiKey && !oauthToken) {
    throw new Error(`Chưa cấu hình API Key hoặc chưa Đăng nhập bằng Google cho Gemini. Hãy vào Cài đặt (⋯) để kết nối.`);
  }

  const model = profile.model || 'gemini-2.0-flash';
  const url = apiKey
    ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (oauthToken) {
    headers['Authorization'] = `Bearer ${oauthToken}`;
  }

  const contents: any[] = [];
  
  for (const h of history) {
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    });
  }
  contents.push({
    role: 'user',
    parts: [{ text: userPrompt }],
  });

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: profile.temperature ?? 0.2,
      },
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini Error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const fullText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (onChunk) {
    onChunk(fullText);
  }
  const sql = extractSqlFromText(fullText);
  return { text: fullText, sql };
}

async function callClaude(req: AiChatRequest): Promise<AiChatResponse> {
  const { profile, systemPrompt, userPrompt, history = [], onChunk, signal } = req;
  const apiKey = profile.apiKey || '';
  if (!apiKey) {
    throw new Error(`Chưa cấu hình API Key cho Anthropic Claude. Hãy vào Cài đặt (⋯) để thêm API Key.`);
  }

  const model = profile.model || 'claude-3-7-sonnet-20250219';
  const url = 'https://api.anthropic.com/v1/messages';

  const messages: any[] = [];
  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: userPrompt });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'dangerously-allow-browser': 'true',
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages,
      max_tokens: profile.maxTokens || 4096,
      temperature: profile.temperature ?? 0.2,
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude Error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const fullText = data.content?.[0]?.text || '';
  if (onChunk) {
    onChunk(fullText);
  }
  const sql = extractSqlFromText(fullText);
  return { text: fullText, sql };
}

async function callOllama(req: AiChatRequest): Promise<AiChatResponse> {
  const { profile, systemPrompt, userPrompt, history = [], onChunk, signal } = req;
  const baseUrl = (profile.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const model = profile.model || 'qwen2.5-coder:latest';

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];
  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: userPrompt });

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      options: {
        temperature: profile.temperature ?? 0.2,
      },
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama Error (${response.status}): ${errText}. Hãy đảm bảo Ollama đang chạy ('ollama serve').`);
  }

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed);
          const chunk = data.message?.content || '';
          if (chunk) {
            fullText += chunk;
            if (onChunk) onChunk(fullText);
          }
        } catch {
          // partial json
        }
      }
    }

    const sql = extractSqlFromText(fullText);
    return { text: fullText, sql };
  }

  return { text: 'Không có dữ liệu phản hồi từ Ollama.' };
}

export async function fetchLiveModels(profile: AiAssistantProfile): Promise<LiveModelItem[]> {
  try {
    switch (profile.provider) {
      case 'gemini': {
        const apiKey = profile.apiKey || '';
        const authState = getGoogleAuthState();
        const oauthToken = !apiKey && authState.isLoggedIn ? authState.accessToken : '';
        if (!apiKey && !oauthToken) return [];

        const url = apiKey
          ? `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
          : `https://generativelanguage.googleapis.com/v1beta/models`;
        const headers: Record<string, string> = {};
        if (oauthToken) headers['Authorization'] = `Bearer ${oauthToken}`;

        const res = await fetch(url, { headers });
        if (!res.ok) return [];
        const data = await res.json();
        const models: LiveModelItem[] = (data.models || [])
          .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m: any) => {
            const cleanId = m.name.replace(/^models\//, '');
            return {
              id: cleanId,
              label: m.displayName ? `${m.displayName} (${cleanId})` : cleanId,
              badge: cleanId.includes('2.0') ? 'Mới' : undefined,
            };
          });
        return models;
      }
      case 'ollama': {
        const baseUrl = (profile.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
        const res = await fetch(`${baseUrl}/api/tags`);
        if (!res.ok) return [];
        const data = await res.json();
        const models: LiveModelItem[] = (data.models || []).map((m: any) => ({
          id: m.name,
          label: `${m.name} (${(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`,
          badge: m.name.includes('coder') ? 'SQL' : undefined,
        }));
        return models;
      }
      case 'claude': {
        const apiKey = profile.apiKey || '';
        if (!apiKey) return [];
        const res = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'dangerously-allow-browser': 'true',
          },
        });
        if (!res.ok) return [];
        const data = await res.json();
        const models: LiveModelItem[] = (data.data || []).map((m: any) => ({
          id: m.id,
          label: m.display_name ? `${m.display_name} (${m.id})` : m.id,
          badge: m.id.includes('3-7') ? 'Mới nhất' : undefined,
        }));
        return models;
      }
      case 'openai':
      case 'deepseek':
      case 'custom': {
        let baseUrl = profile.baseUrl || 'https://api.openai.com/v1';
        if (profile.provider === 'deepseek' && !profile.baseUrl) {
          baseUrl = 'https://api.deepseek.com/v1';
        }
        baseUrl = baseUrl.replace(/\/+$/, '');
        const apiKey = profile.apiKey || '';
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const res = await fetch(`${baseUrl}/models`, { headers });
        if (!res.ok) return [];
        const data = await res.json();
        const rawList: any[] = data.data || [];

        let filtered = rawList;
        if (profile.provider === 'openai') {
          filtered = rawList.filter((m: any) =>
            m.id.startsWith('gpt-') ||
            m.id.startsWith('o1') ||
            m.id.startsWith('o3') ||
            m.id.startsWith('chatgpt-')
          );
        }
        return filtered.map((m: any) => ({
          id: m.id,
          label: m.id,
          badge: m.id.includes('o3') || m.id.includes('4.5') ? 'Mới' : undefined,
        }));
      }
      default:
        return [];
    }
  } catch (err) {
    console.error('Failed to fetch live models:', err);
    return [];
  }
}

export async function testAiConnection(profile: AiAssistantProfile): Promise<{ success: boolean; message: string; liveModels?: LiveModelItem[] }> {
  try {
    const res = await sendAiChat({
      profile,
      systemPrompt: 'You are a test assistant. Reply with "OK" only.',
      userPrompt: 'Ping test connection',
    });
    if (res.error) {
      return { success: false, message: res.error };
    }

    // Attempt to automatically fetch live models
    const liveModels = await fetchLiveModels(profile);

    const countInfo = liveModels.length > 0 ? ` (Đã tải ${liveModels.length} models khả dụng từ tài khoản)` : '';
    return {
      success: true,
      message: `Kết nối thành công tới ${profile.name} (${profile.model})!${countInfo}`,
      liveModels,
    };
  } catch (err: any) {
    return { success: false, message: err?.message || String(err) };
  }
}
