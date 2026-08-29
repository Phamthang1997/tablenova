// Editing a saved connection profile's name, colour and environment in place.
//
// The main profile-writing point is still `persistProfiles` in ConnectionManager.tsx — it also has to
// strip the secrets out of the config and push them into the OS secret store before touching
// localStorage. The function here deliberately only reads, edits and writes three label fields
// (`name`, `color`, `env`) on the copy ALREADY in localStorage, i.e. the stripped one, so there is no
// path by which a password could be written back.
//
// The two writers cannot conflict: ConnectionManager exists only while nothing is connected, and the
// connection details popover only opens once something is.

import type { SavedProfile } from '../components/ConnectionManager';
import type { ConnEnv } from './connEnv';

const PROFILES_KEY = 'tf_connection_profiles';

/**
 * Writes `patch` into the profile with the matching id. Returns `false` when no such profile exists
 * (a hand-built connection never saved as one) or localStorage failed — the display still changes,
 * it simply is not remembered next time.
 */
export function updateProfileDisplay(
  id: string,
  patch: { name?: string; color?: string; env?: ConnEnv },
): boolean {
  if (!id) return false;
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return false;
    const profiles: SavedProfile[] = JSON.parse(raw);
    if (!Array.isArray(profiles)) return false;

    let found = false;
    const next = profiles.map((p) => {
      if (p.id !== id) return p;
      found = true;
      return {
        ...p,
        name: patch.name ?? p.name,
        color: patch.color ?? p.color,
        env: patch.env ?? p.env,
      };
    });
    if (!found) return false;

    localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
