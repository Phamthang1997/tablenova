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
  DownloadCloud,
  LogOut,
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
  { value: 'gemini', label: 'Google Gemini (Web Auth 1-Click & API Key)', defaultModel: 'gemini-2.0-flash' },
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
  
  // Gemini authentication mode: 'oauth' (Web Browser 1-Click) or 'apikey' (Google AI Studio Key)
  const [geminiAuthMode, setGeminiAuthMode] = useState<'oauth' | 'apikey'>(() => {
    const auth = getGoogleAuthState();
    return auth.isLoggedIn ? 'oauth' : 'oauth';
  });

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

  const handleGoogleWebOAuthLogin = async () => {
    setAuthenticatingGoogle(true);
    setTestResult(null);
    try {
      const res = await startGoogleBrowserOAuth();
      if (res.success) {
        const newAuth = getGoogleAuthState();
        setGoogleAuth(newAuth);
        setSettings(getAiSettings());
        setTestResult({
          success: true,
          message: `Đăng nhập Google Web thành công: ${res.email || 'Tài khoản đang hoạt động'}`,
        });
        fetchLiveModels(currentProfile).then((models) => {
          if (models.length > 0) {
            setLiveModelsMap((prev) => ({
              ...prev,
              [currentProfile.id]: models,
            }));
          }
        });
      } else {
        setTestResult({
          success: false,
          message: `Lỗi đăng nhập Google: ${res.error || 'Không thể hoàn tất xác thực.'}`,
        });
      }
    } catch (err: any) {
      setTestResult({
        success: false,
        message: `Lỗi xác thực: ${err?.message || String(err)}`,
      });
    } finally {
      setAuthenticatingGoogle(false);
    }
  };

  const handleGoogleLogout = () => {
    logoutGoogleAuth();
    setGoogleAuth(getGoogleAuthState());
    setSettings(getAiSettings());
    setTestResult({
      success: true,
      message: 'Đã đăng xuất tài khoản Google.',
    });
  };

  const handleOpenBrowserAuth = async () => {
    const info = PROVIDER_AUTH_URLS[currentProfile.provider] || { url: 'https://aistudio.google.com/app/apikey' };
    try {
      await invoke('open_url', { url: info.url });
    } catch {
      window.open(info.url, '_blank');
    }
  };

  const handlePasteApiKey = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        const trimmed = text.trim();
        handleUpdateProfile({ apiKey: trimmed });
        setPasteSuccess(true);
        setTimeout(() => setPasteSuccess(false), 2000);

        if (currentProfile.provider === 'gemini') {
          saveGoogleAuthToken(trimmed, 'Tài khoản Google (Đã xác thực)');
          setGoogleAuth(getGoogleAuthState());
        }

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

                {/* ======================================================== */}
                {/* DEDICATED CLEAN AUTH SECTION FOR GEMINI                  */}
                {/* ======================================================== */}
                {currentProfile.provider === 'gemini' && (
                  <div className="ai-auth-card">
                    <div className="ai-auth-card-top">
                      <div className="ai-auth-segmented-control">
                        <button
                          type="button"
                          className={`ai-auth-segment-btn ${geminiAuthMode === 'oauth' ? 'active' : ''}`}
                          onClick={() => setGeminiAuthMode('oauth')}
                        >
                          <Globe size={13} />
                          <span>Google Web Auth (1-Click)</span>
                          {googleAuth.isLoggedIn && <span className="ai-auth-dot-active" title="Đã kết nối" />}
                        </button>
                        <button
                          type="button"
                          className={`ai-auth-segment-btn ${geminiAuthMode === 'apikey' ? 'active' : ''}`}
                          onClick={() => setGeminiAuthMode('apikey')}
                        >
                          <Key size={13} />
                          <span>API Key (Google AI Studio)</span>
                          {currentProfile.apiKey && <span className="ai-auth-dot-active" title="Đã có Key" />}
                        </button>
                      </div>
                    </div>

                    {/* SUB-TAB 1: GOOGLE WEB OAUTH 1-CLICK */}
                    {geminiAuthMode === 'oauth' && (
                      <div className="ai-auth-tab-content">
                        {googleAuth.isLoggedIn ? (
                          <div className="ai-google-logged-in-box">
                            <div className="ai-google-account-left">
                              <div className="ai-google-logo-box">
                                <span className="ai-google-g-text">G</span>
                              </div>
                              <div className="ai-google-account-details">
                                <div className="ai-google-account-email">{googleAuth.email}</div>
                                <div className="ai-google-account-status">
                                  <span className="ai-dot-green" />
                                  <span>Đã kết nối qua Google Web Auth</span>
                                </div>
                              </div>
                            </div>
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
                          <div className="ai-google-login-box">
                            <div className="ai-google-login-desc">
                              Đăng nhập tài khoản Google qua trình duyệt để tự động kết nối và sử dụng Gemini 2.0 Flash / Pro chỉ với 1 click.
                            </div>
                            <div className="ai-google-login-action-row">
                              <button
                                type="button"
                                className="ai-google-primary-login-btn"
                                onClick={handleGoogleWebOAuthLogin}
                                disabled={authenticatingGoogle}
                              >
                                <span className="ai-google-btn-g">G</span>
                                <span>
                                  {authenticatingGoogle
                                    ? 'Đang chờ xác thực trên trình duyệt...'
                                    : 'Đăng nhập bằng tài khoản Google (1-Click)'}
                                </span>
                                {authenticatingGoogle && <RefreshCw size={13} className="ai-spinning" />}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* SUB-TAB 2: GOOGLE AI STUDIO API KEY */}
                    {geminiAuthMode === 'apikey' && (
                      <div className="ai-auth-tab-content">
                        <div className="ai-apikey-form-wrap">
                          <div className="ai-form-key-input-box">
                            <Key size={13} className="ai-form-key-icon" />
                            <input
                              type={showKey ? 'text' : 'password'}
                              className="ai-form-input with-icon"
                              placeholder="Dán API Key Gemini (AIzaSy...)"
                              value={currentProfile.apiKey || ''}
                              onChange={(e) => handleUpdateProfile({ apiKey: e.target.value })}
                            />
                            <button
                              type="button"
                              className="ai-form-key-toggle-btn"
                              onClick={() => setShowKey(!showKey)}
                              title={showKey ? 'Ẩn key' : 'Hiện key'}
                            >
                              {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                          </div>

                          <div className="ai-apikey-action-chips">
                            <button
                              type="button"
                              className="ai-chip-action-btn"
                              onClick={handleOpenBrowserAuth}
                              title="Mở Google AI Studio để tạo API Key miễn phí"
                            >
                              <ExternalLink size={12} />
                              <span>Lấy Key miễn phí từ Google AI Studio (1-Click)</span>
                            </button>

                            <button
                              type="button"
                              className="ai-chip-paste-btn"
                              onClick={handlePasteApiKey}
                              title="Dán API Key từ Clipboard"
                            >
                              {pasteSuccess ? <Check size={12} className="ai-check-icon" /> : <ClipboardPaste size={12} />}
                              <span>{pasteSuccess ? 'Đã dán Key!' : 'Dán từ Clipboard'}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ======================================================== */}
                {/* AUTH SECTION FOR OTHER PROVIDERS (CLAUDE, OPENAI, ETC)  */}
                {/* ======================================================== */}
                {currentProfile.provider !== 'gemini' && currentProfile.provider !== 'ollama' && (
                  <div className="ai-form-group">
                    <div className="ai-form-label-row">
                      <label className="ai-form-label">API Key / Token</label>
                    </div>
                    <div className="ai-form-key-input-box">
                      <Key size={13} className="ai-form-key-icon" />
                      <input
                        type={showKey ? 'text' : 'password'}
                        className="ai-form-input with-icon"
                        placeholder="sk-... hoặc API Key"
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

                    {authInfo && (
                      <div className="ai-apikey-action-chips">
                        <button
                          type="button"
                          className="ai-chip-action-btn"
                          onClick={handleOpenBrowserAuth}
                          title={`Mở trang ${authInfo.name} để lấy API Key`}
                        >
                          <ExternalLink size={12} />
                          <span>Lấy API Key ({authInfo.name})</span>
                        </button>
                        <button
                          type="button"
                          className="ai-chip-paste-btn"
                          onClick={handlePasteApiKey}
                          title="Dán từ Clipboard"
                        >
                          {pasteSuccess ? <Check size={12} className="ai-check-icon" /> : <ClipboardPaste size={12} />}
                          <span>{pasteSuccess ? 'Đã dán!' : 'Dán từ Clipboard'}</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* ======================================================== */}
                {/* MODEL SELECTION                                          */}
                {/* ======================================================== */}
                <div className="ai-form-group">
                  <div className="ai-form-label-row">
                    <div className="ai-form-label-with-badge">
                      <label className="ai-form-label">Danh sách Model</label>
                      {isLiveFetched ? (
                        <span className="ai-live-model-badge">
                          ✓ Đã tải {dynamicOptions.length} models từ tài khoản
                        </span>
                      ) : (
                        <span className="ai-form-label-hint">Gợi ý mới nhất</span>
                      )}
                    </div>

                    <button
                      type="button"
                      className="ai-fetch-live-models-btn"
                      onClick={() => handleFetchLiveModels()}
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
