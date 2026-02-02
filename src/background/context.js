import { getLocal, setLocal, getSession, setSession, removeSession } from './storage.js';

const LAST_TAG_KEY = 'lastTagName';
const TAB_TAG_PREFIX = 'tabContextTag::';

// In-memory memo for speed (service worker may be suspended at any time).
const memoTabTag = new Map(); // tabId -> tagName

function keyForTab(tabId) {
  return `${TAB_TAG_PREFIX}${String(tabId)}`;
}

export async function getLastGlobalTag() {
  const v = await getLocal(LAST_TAG_KEY, '');
  return (typeof v === 'string') ? v : '';
}

export async function getTabContextTag(tabId) {
  if (memoTabTag.has(tabId)) return memoTabTag.get(tabId);
  const k = keyForTab(tabId);
  const v = await getSession(k, null);
  if (typeof v === 'string') {
    memoTabTag.set(tabId, v);
    return v;
  }
  return null;
}

export function setTabContextTag(tabId, tagName, { persistGlobal = true } = {}) {
  const t = (typeof tagName === 'string') ? tagName : '';
  memoTabTag.set(tabId, t);
  // Persist to session to survive service-worker suspension.
  void setSession(keyForTab(tabId), t).catch(() => {});
  if (persistGlobal) {
    void setLocal(LAST_TAG_KEY, t).catch(() => {});
  }
}

export function clearTabContextTag(tabId) {
  memoTabTag.delete(tabId);
  void removeSession(keyForTab(tabId)).catch(() => {});
}

/**
 * Resolve the effective tagName for a tab.
 *
 * tagNameMode:
 * - 'explicit': the sender is sure about the tag context (including empty string for "all").
 * - 'context': the sender does NOT know; reuse stored tab context.
 * - undefined/other: backward-compatible behavior; if tagName is a string, treat as explicit.
 */
export async function resolveEffectiveTagName(tabId, tagName, tagNameMode) {
  const mode = (tagNameMode === 'explicit' || tagNameMode === 'context') ? tagNameMode : null;
  const msgTag = (typeof tagName === 'string') ? tagName : null;

  if (mode === 'explicit') {
    const t = msgTag ?? '';
    setTabContextTag(tabId, t, { persistGlobal: true });
    return t;
  }

  // Backward compatibility: if sender provides a string and didn't say "context",
  // treat it as explicit.
  if (msgTag !== null && mode !== 'context') {
    setTabContextTag(tabId, msgTag, { persistGlobal: true });
    return msgTag;
  }

  // Context mode: prefer per-tab context, then fallback to global last-used.
  const perTab = await getTabContextTag(tabId);
  if (typeof perTab === 'string') return perTab;

  const last = await getLastGlobalTag();
  return last;
}
