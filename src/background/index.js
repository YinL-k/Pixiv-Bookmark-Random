import { installPximgHeaderRule } from './dnr.js';
import { resolveEffectiveTagName, clearTabContextTag, getLastGlobalTag } from './context.js';
import {
  clampBufferSize,
  ensureTabBuffer,
  consumeFromTabBuffer,
  ensureGlobal,
  buildCandidate,
  cleanupTab,
  getDefaultWarmSize,
  warmStartupPools,
} from './buffer.js';
import { markRecentWorkId } from './recent.js';

// --- Lifecycle: install/startup ---

chrome.runtime.onInstalled.addListener(async () => {
  await installPximgHeaderRule();

  // Warm a small global pool so the first click can be fast.
  warmStartupPools();
  try {
    const lastTag = await getLastGlobalTag();
    if (lastTag) void ensureGlobal(String(lastTag), getDefaultWarmSize(), []).catch(() => {});
  } catch {
    // ignore
  }
});

chrome.runtime.onStartup.addListener(() => {
  // Best-effort: keep rule installed even if Chrome cleared dynamic rules.
  void installPximgHeaderRule().catch(() => {});
  warmStartupPools();
  getLastGlobalTag().then((lastTag) => {
    if (lastTag) void ensureGlobal(String(lastTag), getDefaultWarmSize(), []).catch(() => {});
  }).catch(() => {});
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  cleanupTab(tabId);
  clearTabContextTag(tabId);
});

// --- Messaging ---

async function handleEnsureBuffer(tabId, msg) {
  const size = clampBufferSize(msg.size);
  const excludeIllustIds = Array.isArray(msg.excludeIllustIds) ? msg.excludeIllustIds : [];

  const tagName = await resolveEffectiveTagName(tabId, msg.tagName, msg.tagNameMode);

  // Fire-and-forget warm pool for this tag to keep future requests fast.
  void ensureGlobal(tagName, getDefaultWarmSize(), excludeIllustIds).catch(() => {});

  const queue = await ensureTabBuffer(tabId, tagName, size, excludeIllustIds);
  return { ok: true, queue };
}

async function handleConsumeBuffer(tabId, msg) {
  const size = clampBufferSize(msg.size);
  const excludeIllustIds = Array.isArray(msg.excludeIllustIds) ? msg.excludeIllustIds : [];

  const tagName = await resolveEffectiveTagName(tabId, msg.tagName, msg.tagNameMode);

  void ensureGlobal(tagName, getDefaultWarmSize(), excludeIllustIds).catch(() => {});

  const candidate = await consumeFromTabBuffer(tabId, tagName, size, excludeIllustIds);
  return { ok: true, candidate };
}

async function handleGetRandomNow(tabId, msg) {
  const excludeIllustIds = Array.isArray(msg.excludeIllustIds) ? msg.excludeIllustIds : [];
  const tagName = await resolveEffectiveTagName(tabId, msg.tagName, msg.tagNameMode);

  void ensureGlobal(tagName, getDefaultWarmSize(), excludeIllustIds).catch(() => {});

  const c = await buildCandidate(tagName, excludeIllustIds);
  // This is effectively "consumed" because the caller is about to navigate to it.
  if (c?.illustId) void markRecentWorkId(c.illustId).catch(() => {});
  return { ok: true, candidate: c };
}

async function handleGetContextTag(tabId) {
  const tagName = await resolveEffectiveTagName(tabId, null, 'context');
  return { ok: true, tagName };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  if (!msg || !msg.type) return;

  const replyError = (err) => {
    const m = (err instanceof Error) ? err.message : String(err);
    sendResponse({ ok: false, error: m });
  };

  (async () => {
    if (typeof tabId !== 'number') {
      throw new Error('无法获取 tabId。');
    }

    switch (msg.type) {
      case 'ENSURE_BUFFER':
        return await handleEnsureBuffer(tabId, msg);

      case 'CONSUME_BUFFER':
        return await handleConsumeBuffer(tabId, msg);

      // Backward compatibility
      case 'ENSURE_NEXT': {
        const r = await handleEnsureBuffer(tabId, { ...msg, size: 1 });
        return { ok: true, candidate: r.queue?.[0] || null };
      }

      case 'CONSUME_NEXT':
        return await handleConsumeBuffer(tabId, { ...msg, size: 1 });

      case 'GET_RANDOM_NOW':
        return await handleGetRandomNow(tabId, msg);

      case 'GET_CONTEXT_TAG':
        return await handleGetContextTag(tabId);

      default:
        return;
    }
  })().then((resp) => {
    if (resp !== undefined) sendResponse(resp);
  }).catch(replyError);

  return true;
});
