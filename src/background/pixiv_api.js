import { getLocal, setLocal } from './storage.js';
import { getRecentWorkIds } from './recent.js';

export const PER_PAGE = 48;

const USER_ID_CACHE_KEY = 'cachedUserId';
const USER_ID_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const TOTAL_TTL_MS = 5 * 60 * 1000; // 5min

let memoUserId = null; // { userId: string, cachedAt: number }
const memoTotalByTag = new Map(); // tag -> { total: number, cachedAt: number }

function now() { return Date.now(); }

function normalizeTag(tag) {
  return typeof tag === 'string' ? tag : '';
}

function normalizeUserId(value) {
  const s = String(value ?? '').trim();
  return /^\d+$/.test(s) ? s : '';
}

export async function rememberUserIdHint(value) {
  const userId = normalizeUserId(value);
  if (!userId) return false;

  const entry = { userId, cachedAt: now() };
  memoUserId = entry;
  await setLocal(USER_ID_CACHE_KEY, entry);
  return true;
}

export async function fetchPixivJson(url) {
  let res;
  try {
    res = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      headers: { Accept: 'application/json, text/plain, */*' },
    });
  } catch (e) {
    const detail = (e instanceof Error && e.message) ? ` (${e.message})` : '';
    throw new Error(`无法访问 Pixiv API${detail}`);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`Pixiv API 请求失败: ${res.status}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const finalUrl = res.url || '';
    if (finalUrl.includes('accounts.pixiv.net') || finalUrl.includes('return_to=')) {
      throw new Error('Pixiv 登录状态不可用。请先登录 Pixiv，然后刷新页面。');
    }
    throw new Error('Pixiv API 返回了非 JSON 内容。请刷新 Pixiv 页面后重试。');
  }

  if (data && data.error) throw new Error(data.message || 'Pixiv API 返回错误。');
  return data;
}

export function buildBookmarksApiUrl(userId, tagName, offset, limit) {
  const url = new URL(`https://www.pixiv.net/ajax/user/${userId}/illusts/bookmarks`);
  url.searchParams.set('tag', normalizeTag(tagName));
  url.searchParams.set('offset', String(offset || 0));
  url.searchParams.set('limit', String(limit || PER_PAGE));
  url.searchParams.set('rest', 'show');
  url.searchParams.set('lang', 'en');
  return url.toString();
}

async function resolveUserIdFromSelfEndpoint() {
  const data = await fetchPixivJson('https://www.pixiv.net/ajax/user/self?lang=en');
  const b = data?.body;
  const id = normalizeUserId(
    b?.userId ??
    b?.user_id ??
    b?.id ??
    b?.self?.userId ??
    b?.self?.user_id ??
    b?.self?.id ??
    b?.userData?.userId ??
    b?.userData?.id
  );
  if (id) return id;
  throw new Error('无法从 Pixiv self API 解析用户 ID。');
}

export async function resolveUserId() {
  const t = now();
  if (memoUserId && (t - memoUserId.cachedAt) < USER_ID_TTL_MS) return memoUserId.userId;

  const stored = await getLocal(USER_ID_CACHE_KEY, null);
  if (stored && typeof stored === 'object') {
    const userId = normalizeUserId(stored.userId);
    const cachedAt = stored.cachedAt;
    if (userId && typeof cachedAt === 'number' && (t - cachedAt) < USER_ID_TTL_MS) {
      memoUserId = { userId, cachedAt };
      return userId;
    }
  }

  try {
    const userId = await resolveUserIdFromSelfEndpoint();
    await rememberUserIdHint(userId);
    return userId;
  } catch {
    // Do not use the obsolete /bookmark.php redirect fallback. In Chrome it can
    // redirect to an HTML page and trigger a CORS failure. The content script
    // supplies the logged-in account ID from Pixiv's bootstrap JSON instead.
    throw new Error('无法识别当前 Pixiv 账号。请确认已登录，并刷新任意 Pixiv 页面后重试。');
  }
}

export async function fetchTotalBookmarks(userId, tagName) {
  const tag = normalizeTag(tagName);
  const cached = memoTotalByTag.get(tag);
  const t = now();
  if (cached && (t - cached.cachedAt) < TOTAL_TTL_MS) return cached.total;

  const data = await fetchPixivJson(buildBookmarksApiUrl(userId, tag, 0, 1));
  const total = data?.body?.total;
  if (typeof total !== 'number' || Number.isNaN(total)) throw new Error('无法获取收藏总数。');

  memoTotalByTag.set(tag, { total, cachedAt: t });
  return total;
}

export async function fetchBookmarkPage(userId, tagName, offset, limit) {
  return fetchPixivJson(buildBookmarksApiUrl(userId, tagName, offset, limit));
}

export async function fetchIllustDetails(illustId) {
  const url = `https://www.pixiv.net/ajax/illust/${illustId}?lang=en`;
  return fetchPixivJson(url);
}

export async function fetchIllustPages(illustId) {
  const url = `https://www.pixiv.net/ajax/illust/${illustId}/pages?lang=en`;
  return fetchPixivJson(url);
}

function pickRandom(arr) {
  if (!arr || arr.length === 0) throw new Error('没有可用的收藏作品。');
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function chooseRandomBookmarkedIllustId(tagName, excludeIllustIds) {
  const userId = await resolveUserId();

  const total = await fetchTotalBookmarks(userId, tagName);
  const numPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const pageIndex = Math.floor(Math.random() * numPages);

  const page = await fetchBookmarkPage(userId, tagName, pageIndex * PER_PAGE, PER_PAGE);
  const works = page?.body?.works || [];
  if (!Array.isArray(works) || works.length === 0) {
    if (tagName) return chooseRandomBookmarkedIllustId('', excludeIllustIds);
    throw new Error('收藏列表为空。');
  }

  const excludeSet = new Set((Array.isArray(excludeIllustIds) ? excludeIllustIds : []).map(String));
  const filteredWorks = works.filter(w => w && !excludeSet.has(String(w.id)));
  const pool = filteredWorks.length > 0 ? filteredWorks : works;

  // Recent filtering (IMPORTANT: do NOT mark recent here; only mark on actual consumption)
  const recent = await getRecentWorkIds();
  const unseen = pool.filter(w => !recent.includes(String(w.id)));
  const candidates = unseen.length > 0 ? unseen : pool;

  const chosen = pickRandom(candidates);
  return String(chosen.id);
}

export async function resolveRandomImageUrlFromIllustSkipUgoira(illustId) {
  const details = await fetchIllustDetails(illustId);
  const body = details?.body;
  if (!body) throw new Error('无法获取作品详情。');

  const illustType = body.illustType; // 0/1 illust/manga, 2 ugoira
  const pageCount = body.pageCount || 1;

  if (illustType === 2) {
    return { url: null, isUgoira: true };
  }

  if (pageCount <= 1) {
    const original = body?.urls?.original;
    if (typeof original === 'string' && original.includes('i.pximg.net')) return { url: original, isUgoira: false };
    const regular = body?.urls?.regular;
    if (typeof regular === 'string' && regular.includes('i.pximg.net')) return { url: regular, isUgoira: false };
    return { url: null, isUgoira: false };
  }

  const pages = await fetchIllustPages(illustId);
  const list = pages?.body || [];
  if (!Array.isArray(list) || list.length === 0) return { url: null, isUgoira: false };

  const page = pickRandom(list);
  const original = page?.urls?.original;
  if (typeof original === 'string' && original.includes('i.pximg.net')) return { url: original, isUgoira: false };
  const regular = page?.urls?.regular;
  if (typeof regular === 'string' && regular.includes('i.pximg.net')) return { url: regular, isUgoira: false };

  return { url: null, isUgoira: false };
}
