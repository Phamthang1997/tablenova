/**
 * ER Diagram Layout Persistence.
 * Saves and restores custom user-dragged table node coordinates in localStorage.
 */

import type { ERLayoutPositions } from './erTypes';

const STORAGE_PREFIX = 'tablegrid:er-layout';

function buildStorageKey(connId: string, database?: string, schema?: string): string {
  const dbPart = database ? database.trim() : 'default';
  const schPart = schema ? schema.trim() : 'public';
  return `${STORAGE_PREFIX}:${connId}:${dbPart}:${schPart}`;
}

/**
 * Loads saved layout positions from localStorage if available.
 */
export function loadSavedLayout(
  connId: string,
  database?: string,
  schema?: string
): ERLayoutPositions | null {
  try {
    const key = buildStorageKey(connId, database, schema);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('Failed to load ER layout positions from storage:', err);
    return null;
  }
}

/**
 * Saves current node layout positions to localStorage.
 */
export function saveCurrentLayout(
  connId: string,
  positions: ERLayoutPositions,
  database?: string,
  schema?: string
): void {
  try {
    const key = buildStorageKey(connId, database, schema);
    localStorage.setItem(key, JSON.stringify(positions));
  } catch (err) {
    console.warn('Failed to persist ER layout positions:', err);
  }
}

/**
 * Clears saved layout positions to trigger auto-layout computation.
 */
export function clearSavedLayout(
  connId: string,
  database?: string,
  schema?: string
): void {
  try {
    const key = buildStorageKey(connId, database, schema);
    localStorage.removeItem(key);
  } catch (err) {
    console.warn('Failed to clear saved ER layout:', err);
  }
}
