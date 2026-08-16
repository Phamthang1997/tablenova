import { getAiSettings, saveAiSettings } from './aiConfig';
import { invoke } from '@tauri-apps/api/core';

export const DEFAULT_GOOGLE_CLIENT_ID = 'REDACTED_CLIENT_ID.apps.googleusercontent.com';
export const DEFAULT_GOOGLE_CLIENT_SECRET = 'REDACTED_CLIENT_SECRET';

export interface GoogleAuthState {
  isLoggedIn: boolean;
  email?: string;
  name?: string;
  picture?: string;
  accessToken?: string;
  expiresAt?: number;
}

export function getGoogleAuthState(): GoogleAuthState {
  const settings = getAiSettings();
  if (settings.googleAuthToken) {
    const isExpired = settings.googleAuthExpiresAt ? Date.now() > settings.googleAuthExpiresAt : false;
    if (!isExpired) {
      return {
        isLoggedIn: true,
        email: settings.googleAuthEmail || 'Google Account (Active)',
        accessToken: settings.googleAuthToken,
        expiresAt: settings.googleAuthExpiresAt,
      };
    }
  }
  return { isLoggedIn: false };
}

function generateCodeVerifier(): string {
  const randomBytes = new Uint8Array(48);
  window.crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes)
    .map((b) => ('0' + b.toString(16)).slice(-2))
    .join('');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  const binary = String.fromCharCode(...new Uint8Array(digest));
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const DELETED_CLIENT_IDS = [
  'REDACTED_CLIENT_ID.apps.googleusercontent.com',
  'REDACTED_CLIENT_ID.apps.googleusercontent.com',
];

export async function startGoogleBrowserOAuth(
  customClientId?: string,
  customClientSecret?: string
): Promise<{ success: boolean; email?: string; error?: string; token?: string }> {
  try {
    const settings = getAiSettings();
    let clientId = (customClientId || settings.googleClientId || '').trim();
    if (!clientId || DELETED_CLIENT_IDS.includes(clientId) || !clientId.includes('REDACTED_CLIENT_ID')) {
      clientId = DEFAULT_GOOGLE_CLIENT_ID;
      settings.googleClientId = DEFAULT_GOOGLE_CLIENT_ID;
      settings.googleClientSecret = DEFAULT_GOOGLE_CLIENT_SECRET;
      saveAiSettings(settings);
    }
    const clientSecret = (customClientSecret || settings.googleClientSecret || DEFAULT_GOOGLE_CLIENT_SECRET).trim();

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const res: any = await invoke('start_google_oauth_flow', {
      clientId,
      codeChallenge,
    });

    if (!res || !res.success || !res.code) {
      return {
        success: false,
        error: res?.error || 'Không nhận được mã xác thực từ trình duyệt.',
      };
    }

    // Trao đổi Authorization Code lấy Access Token qua Google OAuth2 Token Endpoint
    const bodyParams = new URLSearchParams();
    bodyParams.append('client_id', clientId);
    if (clientSecret) {
      bodyParams.append('client_secret', clientSecret);
    }
    bodyParams.append('code', res.code);
    bodyParams.append('code_verifier', codeVerifier);
    bodyParams.append('grant_type', 'authorization_code');
    bodyParams.append('redirect_uri', res.redirect_uri || 'http://127.0.0.1/oauth/callback');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: bodyParams.toString(),
    });

    if (!tokenRes.ok) {
      const errJson = await tokenRes.json().catch(() => ({}));
      const errMsg = errJson.error_description || errJson.error || (await tokenRes.text());
      return {
        success: false,
        error: `Lỗi trao đổi token với Google: ${errMsg}`,
      };
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const expiresIn = tokenData.expires_in || 3600;
    const refreshToken = tokenData.refresh_token;

    let userEmail = 'Tài khoản Google (Đã kết nối)';
    try {
      const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (userInfoRes.ok) {
        const info = await userInfoRes.json();
        if (info.email) {
          userEmail = info.email;
        }
      }
    } catch {
      // ignore
    }

    // Lưu cấu hình token
    const currentSettings = getAiSettings();
    currentSettings.googleAuthToken = accessToken;
    currentSettings.googleAuthEmail = userEmail;
    currentSettings.googleAuthExpiresAt = Date.now() + expiresIn * 1000;
    if (refreshToken) {
      currentSettings.googleRefreshToken = refreshToken;
    }
    saveAiSettings(currentSettings);

    return {
      success: true,
      email: userEmail,
      token: accessToken,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}

export const openGoogleBrowserLogin = startGoogleBrowserOAuth;

export function saveGoogleAuthToken(token: string, email?: string, expiresInSeconds: number = 3600 * 24 * 30): void {
  const settings = getAiSettings();
  settings.googleAuthToken = token.trim();
  settings.googleAuthEmail = email || 'Tài khoản Google (Đã kết nối)';
  settings.googleAuthExpiresAt = Date.now() + expiresInSeconds * 1000;
  saveAiSettings(settings);
}

export function logoutGoogleAuth(): void {
  const settings = getAiSettings();
  delete settings.googleAuthToken;
  delete settings.googleRefreshToken;
  delete settings.googleAuthEmail;
  delete settings.googleAuthExpiresAt;
  saveAiSettings(settings);
}
