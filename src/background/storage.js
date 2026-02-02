/**
 * Storage helpers
 * - local: persisted
 * - session: cleared on browser restart, but survives service-worker suspension
 */

function hasSession() {
  return !!(chrome?.storage?.session);
}

export async function getLocal(key, defaultValue) {
  const obj = await chrome.storage.local.get([key]);
  return (obj && obj[key] !== undefined) ? obj[key] : defaultValue;
}

export async function setLocal(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function removeLocal(keys) {
  const arr = Array.isArray(keys) ? keys : [keys];
  await chrome.storage.local.remove(arr);
}

// Session storage is optional; fall back to local with a prefix if needed.
const SESSION_FALLBACK_PREFIX = "__session__::";

export async function getSession(key, defaultValue) {
  if (hasSession()) {
    const obj = await chrome.storage.session.get([key]);
    return (obj && obj[key] !== undefined) ? obj[key] : defaultValue;
  }
  return getLocal(SESSION_FALLBACK_PREFIX + key, defaultValue);
}

export async function setSession(key, value) {
  if (hasSession()) {
    await chrome.storage.session.set({ [key]: value });
    return;
  }
  await setLocal(SESSION_FALLBACK_PREFIX + key, value);
}

export async function removeSession(keys) {
  const arr = Array.isArray(keys) ? keys : [keys];
  if (hasSession()) {
    await chrome.storage.session.remove(arr);
    return;
  }
  await removeLocal(arr.map(k => SESSION_FALLBACK_PREFIX + k));
}
