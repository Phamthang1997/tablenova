import { getAiSettings, saveAiSettings } from './aiConfig';
import { invoke } from '@tauri-apps/api/core';

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

export async function startGoogleBrowserOAuth(): Promise<{ success: boolean; email?: string; error?: string }> {
  try {
    const res: any = await invoke('start_google_oauth_flow', {});
    
    if (res && res.token) {
      let userEmail = 'Tài khoản Google (Đã kết nối)';
      
      // Try to fetch user's profile info using the access token
      try {
        const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${res.token}` },
        });
        if (userInfoRes.ok) {
          const info = await userInfoRes.json();
          if (info.email) {
            userEmail = info.email;
          }
        }
      } catch {
        // ignore userInfo error
      }

      saveGoogleAuthToken(res.token, userEmail, 3600 * 24 * 30);
      return { success: true, email: userEmail };
    } else if (res && res.code) {
      // Received auth code
      saveGoogleAuthToken(res.code, 'Tài khoản Google (Auth Code)', 3600 * 24 * 30);
      return { success: true, email: 'Tài khoản Google (Auth Code)' };
    } else if (res && res.error) {
      return { success: false, error: res.error };
    }
    return { success: false, error: 'Không nhận được mã xác thực.' };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
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
  delete settings.googleAuthEmail;
  delete settings.googleAuthExpiresAt;
  saveAiSettings(settings);
}
