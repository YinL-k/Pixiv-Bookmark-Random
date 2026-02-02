import { getLocal, setLocal } from './storage.js';

export const RECENT_LIMIT = 10;
const KEY = 'recentWorkIds';

export async function getRecentWorkIds() {
  const arr = await getLocal(KEY, []);
  if (!Array.isArray(arr)) return [];
  return arr.map(x => String(x)).filter(Boolean);
}

export async function markRecentWorkId(illustId) {
  const id = String(illustId || '').trim();
  if (!id) return;
  const recent = await getRecentWorkIds();
  // De-dup but keep ordering (most recent at end)
  const filtered = recent.filter(x => x !== id);
  filtered.push(id);
  if (filtered.length > RECENT_LIMIT) {
    filtered.splice(0, filtered.length - RECENT_LIMIT);
  }
  await setLocal(KEY, filtered);
}
