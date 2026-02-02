import { chooseRandomBookmarkedIllustId, resolveRandomImageUrlFromIllustSkipUgoira } from './pixiv_api.js';
import { markRecentWorkId } from './recent.js';

// Prefetch & buffer tuning
const NEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRY_FOR_NON_UGOIRA = 6;

// tabId -> { tagName, queue: Candidate[] }
const bufferByTab = new Map();
const pendingFillByTab = new Map(); // tabId -> Promise<void>

// Cross-tab warm pool: tagName -> Candidate[]
const globalBufferByTag = new Map();
const pendingGlobalFillByTag = new Map(); // tagName -> Promise<void>

function now() { return Date.now(); }

/** @typedef {{ illustId: string, url: string, tagName: string, createdAt: number }} Candidate */

export function clampBufferSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(5, Math.floor(n)));
}

async function warmCache(url) {
  // Best-effort cache warm-up. Even opaque responses can populate HTTP cache.
  try {
    await fetch(url, { mode: 'no-cors', cache: 'force-cache' });
  } catch {
    // ignore
  }
}

function candidateFresh(c, tagName) {
  if (!c) return false;
  if ((c.tagName || '') !== (tagName || '')) return false;
  return (now() - (c.createdAt || 0)) < NEXT_TTL_MS;
}

function toIdSet(ids) {
  if (!Array.isArray(ids)) return new Set();
  return new Set(ids.map(x => String(x)).filter(Boolean));
}

function toUrlSet(urls) {
  if (!Array.isArray(urls)) return new Set();
  return new Set(urls.map(x => String(x)).filter(Boolean));
}

export async function buildCandidate(tagName, excludeIllustIds, excludeUrls) {
  const t = tagName || '';
  const excludeIdSet = excludeIllustIds instanceof Set ? excludeIllustIds : toIdSet(excludeIllustIds);
  const excludeUrlSet = excludeUrls instanceof Set ? excludeUrls : toUrlSet(excludeUrls);

  let lastErr = null;
  for (let i = 0; i < MAX_RETRY_FOR_NON_UGOIRA; i++) {
    try {
      const illustId = await chooseRandomBookmarkedIllustId(t, Array.from(excludeIdSet));
      if (excludeIdSet.has(String(illustId))) continue;

      const resolved = await resolveRandomImageUrlFromIllustSkipUgoira(illustId);
      if (resolved.isUgoira) continue;
      if (!resolved.url) continue;

      if (excludeUrlSet.has(String(resolved.url))) continue;
      return { illustId: String(illustId), url: String(resolved.url), tagName: t, createdAt: now() };
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr) {
    const msg = (lastErr instanceof Error) ? lastErr.message : String(lastErr);
    throw new Error(msg);
  }
  throw new Error('无法生成随机图片（可能收藏多为动图或不可用）。');
}

function normalizeQueue(rawQueue, tagName, excludeIllustIds) {
  const t = tagName || '';
  const excludeIdSet = toIdSet(excludeIllustIds);
  const q = Array.isArray(rawQueue) ? rawQueue : [];

  const filtered = q.filter(c => candidateFresh(c, t) && !excludeIdSet.has(String(c.illustId)));
  const seen = new Set();
  const deduped = [];
  for (const c of filtered) {
    const key = String(c?.url || '');
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return { tagName: t, queue: deduped };
}

async function fillGlobal(tagName, size, excludeIllustIds) {
  const t = tagName || '';
  const target = clampBufferSize(size);
  const entry = normalizeQueue(globalBufferByTag.get(t), t, excludeIllustIds);
  const queue = entry.queue;

  const baseExcludeIds = toIdSet(excludeIllustIds);
  while (queue.length < target) {
    const bufferIds = new Set(queue.map(c => String(c.illustId)).filter(Boolean));
    const bufferUrls = new Set(queue.map(c => String(c.url)).filter(Boolean));
    const mergedExcludeIds = new Set([...baseExcludeIds, ...bufferIds]);

    const cand = await buildCandidate(t, mergedExcludeIds, bufferUrls);
    queue.push(cand);
    void warmCache(cand.url);
  }

  globalBufferByTag.set(t, queue);
}

export async function ensureGlobal(tagName, size, excludeIllustIds) {
  const t = tagName || '';
  const target = clampBufferSize(size);

  for (let guard = 0; guard < 3; guard++) {
    const current = normalizeQueue(globalBufferByTag.get(t), t, excludeIllustIds);
    if (current.queue.length >= target) {
      globalBufferByTag.set(t, current.queue);
      return current.queue.slice(0, target);
    }

    let pending = pendingGlobalFillByTag.get(t);
    if (!pending) {
      pending = fillGlobal(t, target, excludeIllustIds).finally(() => pendingGlobalFillByTag.delete(t));
      pendingGlobalFillByTag.set(t, pending);
    }
    await pending;
  }

  const updated = normalizeQueue(globalBufferByTag.get(t), t, excludeIllustIds);
  globalBufferByTag.set(t, updated.queue);
  return updated.queue.slice(0, target);
}

function takeFromGlobal(tagName, excludeIdSet, excludeUrlSet) {
  const t = tagName || '';
  const entry = normalizeQueue(globalBufferByTag.get(t), t, Array.from(excludeIdSet || []));
  const queue = entry.queue;

  while (queue.length > 0) {
    const cand = queue.shift();
    if (!cand?.url) continue;
    if (excludeIdSet?.has?.(String(cand.illustId))) continue;
    if (excludeUrlSet?.has?.(String(cand.url))) continue;
    globalBufferByTag.set(t, queue);
    return cand;
  }

  globalBufferByTag.set(t, queue);
  return null;
}

async function fillTab(tabId, tagName, size, excludeIllustIds) {
  const t = tagName || '';
  const target = clampBufferSize(size);

  const existing = bufferByTab.get(tabId);
  const base = (existing && (existing.tagName || '') === t) ? existing.queue : [];
  const entry = normalizeQueue(base, t, excludeIllustIds);
  const queue = entry.queue;

  const baseExcludeIds = toIdSet(excludeIllustIds);
  while (queue.length < target) {
    const bufferIds = new Set(queue.map(c => String(c.illustId)).filter(Boolean));
    const bufferUrls = new Set(queue.map(c => String(c.url)).filter(Boolean));
    const mergedExcludeIds = new Set([...baseExcludeIds, ...bufferIds]);

    // Prefer pulling from global warm pool to reduce Pixiv API calls.
    let cand = takeFromGlobal(t, mergedExcludeIds, bufferUrls);
    if (cand) {
      void ensureGlobal(t, target, Array.from(mergedExcludeIds)).catch(() => {});
    }
    if (!cand) {
      // Warm global pool once, then retry.
      await ensureGlobal(t, target, Array.from(mergedExcludeIds)).catch(() => {});
      cand = takeFromGlobal(t, mergedExcludeIds, bufferUrls);
    }
    if (!cand) cand = await buildCandidate(t, mergedExcludeIds, bufferUrls);

    queue.push(cand);
    void warmCache(cand.url);
  }

  bufferByTab.set(tabId, { tagName: t, queue });
}

export async function ensureTabBuffer(tabId, tagName, size, excludeIllustIds) {
  const t = tagName || '';
  const target = clampBufferSize(size);

  for (let guard = 0; guard < 3; guard++) {
    const existing = bufferByTab.get(tabId);
    const base = (existing && (existing.tagName || '') === t) ? existing.queue : [];
    const current = normalizeQueue(base, t, excludeIllustIds);

    if (current.queue.length >= target) {
      bufferByTab.set(tabId, { tagName: t, queue: current.queue });
      return current.queue.slice(0, target);
    }

    let pending = pendingFillByTab.get(tabId);
    if (!pending) {
      pending = fillTab(tabId, t, target, excludeIllustIds).finally(() => pendingFillByTab.delete(tabId));
      pendingFillByTab.set(tabId, pending);
    }
    await pending;
  }

  const existing = bufferByTab.get(tabId);
  const base = (existing && (existing.tagName || '') === t) ? existing.queue : [];
  const updated = normalizeQueue(base, t, excludeIllustIds);
  bufferByTab.set(tabId, { tagName: t, queue: updated.queue });
  return updated.queue.slice(0, target);
}

export async function consumeFromTabBuffer(tabId, tagName, size, excludeIllustIds) {
  const t = tagName || '';
  const target = clampBufferSize(size);

  const queue = await ensureTabBuffer(tabId, t, target, excludeIllustIds);
  const cand = queue?.[0];
  if (!cand) {
    // If ensureTabBuffer returned empty unexpectedly, build directly.
    const direct = await buildCandidate(t, excludeIllustIds);
    void warmCache(direct.url);
    void markRecentWorkId(direct.illustId).catch(() => {});
    // Top up for next time.
    void ensureTabBuffer(tabId, t, target, excludeIllustIds).catch(() => {});
    return direct;
  }

  // Pop head from the real stored queue (normalize to keep consistent)
  const existing = bufferByTab.get(tabId);
  const base = (existing && (existing.tagName || '') === t) ? existing.queue : [];
  const normalized = normalizeQueue(base, t, excludeIllustIds);
  const realQueue = normalized.queue;
  const head = realQueue.shift();
  bufferByTab.set(tabId, { tagName: t, queue: realQueue });

  if (head?.illustId) void markRecentWorkId(head.illustId).catch(() => {});

  // Fire-and-forget: top up after consumption.
  void ensureTabBuffer(tabId, t, target, excludeIllustIds).catch(() => {});
  return head;
}

export function cleanupTab(tabId) {
  bufferByTab.delete(tabId);
  pendingFillByTab.delete(tabId);
}

export function getDefaultWarmSize() {
  return 2;
}

export function warmStartupPools() {
  // Warm "all" pool at startup.
  void ensureGlobal('', getDefaultWarmSize(), []).catch(() => {});
}
