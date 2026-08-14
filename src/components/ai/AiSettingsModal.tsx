import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Settings,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  RefreshCw,
  Globe,
  Key,
  ShieldCheck,
  ExternalLink,
  ClipboardPaste,
  Sparkles,
  DownloadCloud,
  LogOut,
  UserCheck,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { AiProviderIcon } from './AiIcons';
import {
  getAiSettings,
  saveAiSettings,
  PROVIDER_MODELS,
  PROVIDER_AUTH_URLS,
} from '../../utils/aiConfig';
import type {
  AiAssistantProfile,
  AiProviderType,
  AiSettings,
  AiModelOption,
} from '../../utils/aiConfig';
import { testAiConnection, fetchLiveModels } from '../../utils/aiService';
import {
  getGoogleAuthState,
  startGoogleBrowserOAuth,
  saveGoogleAuthToken,
  logoutGoogleAuth,
} from '../../utils/aiAuth';

interface AiSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const PROVIDER_OPTIONS: Array<{ value: AiProviderType; label: string; defaultModel: string; placeholderUrl?: string }> = [
  { value: 'gemini', label: 'Google Gemini (Hỗ trợ Browser Auth)', defaultModel: 'gemini-2.0-flash' },
  { value: 'claude', label: 'Anthropic Claude', defaultModel: 'claude-3-7-sonnet-20250219' },
  { value: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-chat', placeholderUrl: 'https://api.deepseek.com/v1' },
  { value: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o-mini' },
  { value: 'ollama', label: 'Ollama (Local Offline)', defaultModel: 'qwen2.5-coder:latest', placeholderUrl: 'http://localhost:11434' },
  { value: 'custom', label: 'Custom OpenAI-compatible / OpenRouter', defaultModel: 'anthropic/claude-3.7-sonnet', placeholderUrl: 'https://openrouter.ai/api/v1' },
];

export const AiSettingsModal: React.FC<AiSettingsModalProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AiSettings>(() => getAiSettings());
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    () => settings.activeProfileId || settings.profiles[0]?.id || 'assistant-1'
  );
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [pasteSuccess, setPasteSuccess] = useState(false);
  const [liveModelsMap, setLiveModelsMap] = useState<Record<string, AiModelOption[]>>({});
  const [googleAuth, setGoogleAuth] = useState(() => getGoogleAuthState());

  const [authenticatingGoogle, setAuthenticatingGoogle] = useState(false);

  const currentProfile =
    settings.profiles.find((p) => p.id === selectedProfileId) || settings.profiles[0];

  const handleFetchLiveModels = useCallback(async (profileToFetch?: AiAssistantProfile) => {
    const target = profileToFetch || currentProfile;
    if (!target) return;
    setFetchingModels(true);
    try {
      const models = await fetchLiveModels(target);
      if (models.length > 0) {
        setLiveModelsMap((prev) => ({
          ...prev,
          [target.id]: models,
        }));
      }
    } catch {
      // ignore
    } finally {
      setFetchingModels(false);
    }
  }, [currentProfile]);

  // Auto-fetch live models when modal opens if API key, Google Auth, or Ollama is ready
  useEffect(() => {
    if (!open || !currentProfile) return;
    setGoogleAuth(getGoogleAuthState());
    if (
      currentProfile.provider === 'ollama' ||
      currentProfile.apiKey ||
      (currentProfile.provider === 'gemini' && getGoogleAuthState().isLoggedIn)
    ) {
      handleFetchLiveModels(currentProfile);
    }
  }, [open, selectedProfileId, currentProfile, handleFetchLiveModels]);

  const handleUpdateProfile = (updates: Partial<AiAssistantProfile>) => {
    setSettings((prev) => {
      const newProfiles = prev.profiles.map((p) =>
        p.id === currentProfile.id ? { ...p, ...updates } : p
      );
      const newSettings = { ...prev, profiles: newProfiles };
      saveAiSettings(newSettings);
      return newSettings;
    });
    setTestResult(null);
  };

  const handleAddProfile = () => {
    const newId = `assistant-${Date.now()}`;
    const newProfile: AiAssistantProfile = {
      id: newId,
      name: `Assistant ${settings.profiles.length + 1}`,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      temperature: 0.2,
      enabled: true,
    };
    setSettings((prev) => {
      const newSettings = { ...prev, profiles: [...prev.profiles, newProfile] };
      saveAiSettings(newSettings);
      return newSettings;
    });
    setSelectedProfileId(newId);
  };

  const handleDeleteProfile = (id: string) => {
    if (settings.profiles.length <= 1) return;
    setSettings((prev) => {
      const newProfiles = prev.profiles.filter((p) => p.id !== id);
      const newSettings = {
        ...prev,
        profiles: newProfiles,
        activeProfileId: prev.activeProfileId === id ? newProfiles[0].id : prev.activeProfileId,
      };
      saveAiSettings(newSettings);
      return newSettings;
    });
    setSelectedProfileId(settings.profiles[0].id);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await testAiConnection(currentProfile);
    setTesting(false);
    setTestResult(res);

    if (res.liveModels && res.liveModels.length > 0) {
      setLiveModelsMap((prev) => ({
        ...prev,
        [currentProfile.id]: res.liveModels!,
      }));
    }
  };

  const handleOpenBrowserAuth = async () => {
    if (currentProfile.provider === 'gemini') {
      setAuthenticatingGoogle(true);
      setTestResult(null);
      try {
        const res = await startGoogleBrowserOAuth();
        if (res.success) {
          const newAuth = getGoogleAuthState();
          setGoogleAuth(newAuth);
          setTestResult({
            success: true,
            message: `Đăng nhập Google thành công: ${res.email || 'Tài khoản đang hoạt động'}`,
          });
          // Tự động tải danh sách live models cho Gemini
          fetchLiveModels(currentProfile).then((models) => {
            if (models.length > 0) {
              setLiveModelsMap((prev) => ({
                ...prev,
                [currentProfile.id]: models,
              }));
            }
          });
        } else if (res.error) {
          setTestResult({ success: false, message: `Lỗi đăng nhập Google: ${res.error}` });
        }
      } catch (err: any) {
        setTestResult({ success: false, message: `Lỗi xác thực: ${err?.message || String(err)}` });
      } finally {
        setAuthenticatingGoogle(false);
      }
    } else {
      const info = PROVIDER_AUTH_URLS[currentProfile.provider];
      if (!info) return;
      try {
        await invoke('open_url', { url: info.url });
      } catch {
        window.open(info.url, '_blank');
      }
    }
  };

  const handleGoogleLogout = () => {
    logoutGoogleAuth();
    setGoogleAuth(getGoogleAuthState());
    setSettings(getAiSettings());
  };

  const handlePasteApiKey = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        const trimmed = text.trim();
        handleUpdateProfile({ apiKey: trimmed });
        setPasteSuccess(true);
        setTimeout(() => setPasteSuccess(false), 2000);

        // If it looks like a Google token or key, also save to googleAuthToken
        if (currentProfile.provider === 'gemini') {
          saveGoogleAuthToken(trimmed, 'Tài khoản Google (Đã xác thực)');
          setGoogleAuth(getGoogleAuthState());
        }

        // Auto trigger live model fetch with the new key
        const tempProfile = { ...currentProfile, apiKey: trimmed };
        fetchLiveModels(tempProfile).then((models) => {
          if (models.length > 0) {
            setLiveModelsMap((prev) => ({
              ...prev,
              [currentProfile.id]: models,
            }));
          }
        });
      }
    } catch {
      // ignore
    }
  };

  const staticOptions = PROVIDER_MODELS[currentProfile.provider] || [];
  const dynamicOptions = liveModelsMap[currentProfile.id] || [];
  const modelOptions = dynamicOptions.length > 0 ? dynamicOptions : staticOptions;
  const isLiveFetched = dynamicOptions.length > 0;
  const authInfo = PROVIDER_AUTH_URLS[currentProfile?.provider || 'gemini'];

  if (!open || !currentProfile) return null;

  return (
    <div className="ai-modal-backdrop" onClick={onClose}>
      <div className="ai-modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="ai-modal-header">
          <div className="ai-modal-header-title">
            <Settings size={16} className="ai-modal-header-icon" />
            <span>{t('ai.settingsTitle', 'Cấu hình Trợ lý AI & API')}</span>
          </div>
          <button className="ai-modal-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="ai-modal-body">
          {/* Left Column: Profile list */}
          <div className="ai-modal-sidebar">
            <div className="ai-modal-sidebar-header">
              <span>Danh sách Trợ lý</span>
              <button className="ai-modal-add-profile-btn" onClick={handleAddProfile} title="Thêm Trợ lý mới">
                <Plus size={12} />
                <span>Thêm</span>
              </button>
            </div>

            <div className="ai-modal-profile-list">
              {settings.profiles.map((p) => (
                <div
                  key={p.id}
                  className={`ai-modal-profile-tab ${p.id === selectedProfileId ? 'active' : ''}`}
                  onClick={() => setSelectedProfileId(p.id)}
                >
                  <div className="ai-modal-tab-icon">
                    <AiProviderIcon provider={p.provider} size={14} />
                  </div>
                  <div className="ai-modal-tab-info">
                    <div className="ai-modal-tab-name">{p.name}</div>
                    <div className="ai-modal-tab-sub">{p.model}</div>
                  </div>
                  {p.id === settings.activeProfileId && (
                    <span className="ai-modal-tab-default-tag">Mặc định</span>
                  )}
                </div>
              ))}
            </div>

            {/* Quick Ollama & Local Info */}
            <div className="ai-modal-oauth-box">
              <ShieldCheck size={14} className="ai-modal-shield-icon" />
              <div className="ai-modal-oauth-text">
                Hỗ trợ <strong>Ollama Local</strong> miễn phí 100% không cần key!
              </div>
            </div>
          </div>

          {/* Right Column: Profile Configuration Form */}
          {currentProfile && (
            <div className="ai-modal-form-area">
              <div className="ai-modal-form-title-row">
                <div className="ai-modal-form-title">
                  <span>Cài đặt {currentProfile.name}</span>
                </div>
                <div className="ai-modal-form-top-actions">
                  {currentProfile.id !== settings.activeProfileId && (
                    <button
                      className="ai-modal-btn-sub"
                      onClick={() => {
                        const newSettings = { ...settings, activeProfileId: currentProfile.id };
                        setSettings(newSettings);
                        saveAiSettings(newSettings);
                      }}
                    >
                      Đặt làm mặc định
                    </button>
                  )}
                  {settings.profiles.length > 1 && (
                    <button
                      className="ai-modal-btn-danger"
                      onClick={() => handleDeleteProfile(currentProfile.id)}
                      title="Xóa trợ lý này"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>

              {/* DEDICATED GOOGLE BROWSER OAUTH CARD FOR GEMINI */}
              {currentProfile.provider === 'gemini' && (
                <div className="ai-google-oauth-card">
                  <div className="ai-google-oauth-header">
                    <div className="ai-google-logo-box">
                      <span className="ai-google-g-text">G</span>
                    </div>
                    <div className="ai-google-oauth-info">
                      <div className="ai-google-oauth-title">
                        {googleAuth.isLoggedIn
                          ? 'Đã đăng nhập bằng tài khoản Google'
                          : 'Đăng nhập 1-Click bằng Google (Browser Auth)'}
                      </div>
                      <div className="ai-google-oauth-desc">
                        {googleAuth.isLoggedIn
                          ? `${googleAuth.email} • Sử dụng trực tiếp Gemini 2.0 Flash / Pro`
                          : 'Đăng nhập bằng tài khoản Google trên trình duyệt để sử dụng Gemini 2.0 miễn phí không cần cấu hình phức tạp.'}
                      </div>
                    </div>
                  </div>

                  <div className="ai-browser-auth-action-row">
                    {googleAuth.isLoggedIn ? (
                      <div className="ai-google-connected-actions">
                        <span className="ai-google-active-badge">
                          <UserCheck size={12} />
                          <span>Tài khoản đang hoạt động</span>
                        </span>
                        <button
                          type="button"
                          className="ai-google-logout-btn"
                          onClick={handleGoogleLogout}
                        >
                          <LogOut size={12} />
                          <span>Đăng xuất</span>
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="ai-google-login-btn"
                        onClick={handleOpenBrowserAuth}
                        disabled={authenticatingGoogle}
                      >
                        <RefreshCw size={13} className={authenticatingGoogle ? 'ai-spinning' : ''} />
                        <span>
                          {authenticatingGoogle
                            ? 'Đang chờ đăng nhập trên trình duyệt...'
                            : 'Đăng nhập bằng Google (Browser Auth)'}
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      className="ai-browser-paste-btn"
                      onClick={handlePasteApiKey}
                      title="Dán Token hoặc Key sao chép từ trình duyệt"
                    >
                      {pasteSuccess ? <Check size={13} className="ai-check-icon" /> : <ClipboardPaste size={13} />}
                      <span>{pasteSuccess ? 'Đã dán Token!' : 'Dán từ Clipboard'}</span>
                    </button>
                  </div>
                </div>
              )}

              {/* 1-Click Platform Portal for Other Providers */}
              {currentProfile.provider !== 'gemini' && authInfo && (
                <div className="ai-browser-auth-card">
                  <div className="ai-browser-auth-header">
                    <div className="ai-browser-auth-icon-wrap">
                      <Sparkles size={14} className="ai-browser-auth-sparkle" />
                    </div>
                    <div className="ai-browser-auth-info">
                      <div className="ai-browser-auth-title">
                        Xác thực qua Trình duyệt ({authInfo.name})
                      </div>
                      <div className="ai-browser-auth-desc">{authInfo.note}</div>
                    </div>
                  </div>

                  <div className="ai-browser-auth-action-row">
                    <button
                      type="button"
                      className="ai-browser-auth-btn"
                      onClick={handleOpenBrowserAuth}
                    >
                      <ExternalLink size={13} />
                      <span>Mở trình duyệt lấy Key</span>
                    </button>

                    {currentProfile.provider !== 'ollama' && (
                      <button
                        type="button"
                        className="ai-browser-paste-btn"
                        onClick={handlePasteApiKey}
                        title="Dán nhanh API Key vừa sao chép từ trình duyệt"
                      >
                        {pasteSuccess ? <Check size={13} className="ai-check-icon" /> : <ClipboardPaste size={13} />}
                        <span>{pasteSuccess ? 'Đã dán!' : 'Dán từ Clipboard'}</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="ai-modal-form-grid">
                {/* Assistant Name */}
                <div className="ai-form-group">
                  <label className="ai-form-label">Tên hiển thị</label>
                  <input
                    type="text"
                    className="ai-form-input"
                    value={currentProfile.name}
                    onChange={(e) => handleUpdateProfile({ name: e.target.value })}
                  />
                </div>

                {/* Provider Selection */}
                <div className="ai-form-group">
                  <label className="ai-form-label">Nhà cung cấp (Provider)</label>
                  <select
                    className="ai-form-select"
                    value={currentProfile.provider}
                    onChange={(e) => {
                      const newProv = e.target.value as AiProviderType;
                      const opt = PROVIDER_OPTIONS.find((o) => o.value === newProv);
                      handleUpdateProfile({
                        provider: newProv,
                        model: opt?.defaultModel || currentProfile.model,
                        baseUrl: opt?.placeholderUrl || '',
                      });
                    }}
                  >
                    {PROVIDER_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Latest / Live Dynamic Models Selection Dropdown & Custom Model Input */}
                <div className="ai-form-group">
                  <div className="ai-form-label-row">
                    <div className="ai-form-label-with-badge">
                      <label className="ai-form-label">Danh sách Model</label>
                      {isLiveFetched ? (
                        <span className="ai-live-model-badge">
                          ✓ Đã tải {dynamicOptions.length} models trực tiếp từ tài khoản
                        </span>
                      ) : (
                        <span className="ai-form-label-hint">Các mẫu model gợi ý mới nhất</span>
                      )}
                    </div>

                    <button
                      type="button"
                      className="ai-fetch-live-models-btn"
                      onClick={handleFetchLiveModels}
                      disabled={
                        fetchingModels ||
                        (currentProfile.provider !== 'ollama' &&
                          !currentProfile.apiKey &&
                          !(currentProfile.provider === 'gemini' && googleAuth.isLoggedIn))
                      }
                      title="Tải danh sách model khả dụng trực tiếp từ API tài khoản"
                    >
                      <DownloadCloud size={12} className={fetchingModels ? 'ai-spinning' : ''} />
                      <span>{fetchingModels ? 'Đang tải...' : 'Tải model từ tài khoản'}</span>
                    </button>
                  </div>

                  {modelOptions.length > 0 && (
                    <select
                      className="ai-form-select ai-model-preset-select"
                      value={modelOptions.some((m) => m.id === currentProfile.model) ? currentProfile.model : 'custom'}
                      onChange={(e) => {
                        if (e.target.value !== 'custom') {
                          handleUpdateProfile({ model: e.target.value });
                        }
                      }}
                    >
                      {modelOptions.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} {m.badge ? `[${m.badge}]` : ''}
                        </option>
                      ))}
                      <option value="custom">✏️ Tùy chỉnh (Tự nhập model ID khác)...</option>
                    </select>
                  )}

                  <input
                    type="text"
                    className="ai-form-input"
                    placeholder="ví dụ: gemini-2.0-flash, claude-3-7-sonnet-20250219, deepseek-chat, gpt-4o"
                    value={currentProfile.model}
                    onChange={(e) => handleUpdateProfile({ model: e.target.value })}
                  />
                </div>

                {/* API Key (if not Ollama) */}
                {currentProfile.provider !== 'ollama' && (
                  <div className="ai-form-group">
                    <div className="ai-form-label-row">
                      <label className="ai-form-label">API Key / Token</label>
                      {currentProfile.provider === 'gemini' && googleAuth.isLoggedIn && (
                        <span className="ai-live-model-badge">Đang dùng Google Browser Auth</span>
                      )}
                    </div>
                    <div className="ai-form-key-input-box">
                      <Key size={13} className="ai-form-key-icon" />
                      <input
                        type={showKey ? 'text' : 'password'}
                        className="ai-form-input with-icon"
                        placeholder={
                          currentProfile.provider === 'gemini' && googleAuth.isLoggedIn
                            ? 'Đã kết nối qua Google Browser Auth (Không bắt buộc nhập)'
                            : 'sk-... hoặc AIzaSy...'
                        }
                        value={currentProfile.apiKey || ''}
                        onChange={(e) => handleUpdateProfile({ apiKey: e.target.value })}
                      />
                      <button
                        type="button"
                        className="ai-form-key-toggle-btn"
                        onClick={() => setShowKey((prev) => !prev)}
                        title={showKey ? 'Ẩn Key' : 'Hiện Key'}
                      >
                        {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    </div>
                  </div>
                )}

                {/* Base URL (for Ollama, DeepSeek, or Custom) */}
                {(currentProfile.provider === 'ollama' ||
                  currentProfile.provider === 'custom' ||
                  currentProfile.provider === 'deepseek') && (
                  <div className="ai-form-group">
                    <label className="ai-form-label">
                      {currentProfile.provider === 'ollama' ? 'Ollama Server URL' : 'API Base URL'}
                    </label>
                    <div className="ai-form-key-input-box">
                      <Globe size={13} className="ai-form-key-icon" />
                      <input
                        type="text"
                        className="ai-form-input with-icon"
                        placeholder={
                          currentProfile.provider === 'ollama'
                            ? 'http://localhost:11434'
                            : 'https://api.openai.com/v1'
                        }
                        value={currentProfile.baseUrl || ''}
                        onChange={(e) => handleUpdateProfile({ baseUrl: e.target.value })}
                      />
                    </div>
                  </div>
                )}

                {/* Enable for Comparison */}
                <div className="ai-form-checkbox-row">
                  <label className="ai-checkbox-label">
                    <input
                      type="checkbox"
                      checked={currentProfile.enabled !== false}
                      onChange={(e) => handleUpdateProfile({ enabled: e.target.checked })}
                    />
                    <span>Hiện trợ lý này trong danh sách so sánh câu trả lời ("You can compare this answer with...")</span>
                  </label>
                </div>
              </div>

              {/* Test Result Message */}
              {testResult && (
                <div className={`ai-test-feedback-box ${testResult.success ? 'success' : 'error'}`}>
                  {testResult.success ? (
                    <Check size={14} className="ai-test-icon success" />
                  ) : (
                    <AlertCircle size={14} className="ai-test-icon error" />
                  )}
                  <span>{testResult.message}</span>
                </div>
              )}

              {/* Action Buttons */}
              <div className="ai-modal-bottom-actions">
                <button
                  type="button"
                  className="ai-modal-test-btn"
                  onClick={handleTestConnection}
                  disabled={testing}
                >
                  <RefreshCw size={13} className={testing ? 'ai-spinning' : ''} />
                  <span>{testing ? 'Đang kiểm tra...' : 'Kiểm tra kết nối & Tải Model'}</span>
                </button>

                <button type="button" className="ai-modal-done-btn" onClick={onClose}>
                  <span>Hoàn tất</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
