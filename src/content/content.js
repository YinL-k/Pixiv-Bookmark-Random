/**
 * Content Script
 * - Injects a persistent bottom-right "Random" button (survives Pixiv SPA navigation).
 * - Maintains a 2-slot local preload buffer (Image()) mirrored from the background buffer.
 * - Works on both https://www.pixiv.net/* and https://i.pximg.net/* pages.
 *
 * Key fixes vs previous iteration:
 * - Tag context persistence: when the current URL doesn't expose a tag (e.g. /artworks/<id> or i.pximg.net), we DO NOT overwrite tag with "".
 *   Instead we ask the background to reuse per-tab context (tagNameMode: "context").
 * - Concurrency: ensure() calls are coalesced so rapid SPA navigations don't drop prefetch refreshes.
 * - UI state: busy label and dots no longer fight each other.
 */

(() => {
  const BTN_ID = 'pixiv-random-bookmark-image-btn';
  const BUFFER_SIZE = 2;

  const BTN_LABEL = 'Random';
  const BTN_LABEL_BUSY = 'Randomizing…';

  const STATE = {
    lastHref: '',
    // Last explicit tag context observed from a bookmarks list URL (can be "").
    lastExplicitTag: undefined, // string | undefined

    queue: Array(BUFFER_SIZE).fill(null),
    ready: Array(BUFFER_SIZE).fill(false),
    preloaders: Array(BUFFER_SIZE).fill(null),

    // ensure() coalescing
    ensureInFlight: null, // Promise<void> | null
    pendingEnsureReq: null, // TagReq | null

    uiBusy: false,
    uiError: '',

    btnEl: null,
  };

  /**
   * @typedef {{ tagName: string|null, tagNameMode: 'explicit'|'context' }} TagReq
   */

  function isPixivHost(hostname) {
    return hostname === 'www.pixiv.net';
  }

  function safeUrl(urlStr) {
    try {
      return new URL(urlStr);
    } catch {
      return null;
    }
  }

  function parseTagFromUrl(urlStr) {
    const u = safeUrl(urlStr);
    if (!u) return '';
    if (!isPixivHost(u.hostname)) return '';

    const qTag = u.searchParams.get('tag');
    if (qTag) return qTag;

    // /users/<id>/bookmarks/artworks/<tag>
    const m = u.pathname.match(/\/bookmarks\/artworks\/([^\/]+)/);
    if (m && m[1]) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    }
    return '';
  }

  function isBookmarksListUrl(urlStr) {
    const u = safeUrl(urlStr);
    if (!u) return false;
    if (!isPixivHost(u.hostname)) return false;

    // Examples:
    // - /users/123/bookmarks/artworks
    // - /en/users/123/bookmarks/artworks
    // - /users/123/bookmarks/artworks/<tag>
    return /^\/(?:[a-z]{2}\/)?users\/\d+\/bookmarks\/artworks(?:\/.*)?$/.test(u.pathname);
  }

  function parseIllustIdFromUrl(urlStr) {
    const u = safeUrl(urlStr);
    if (!u) return '';

    if (u.hostname === 'www.pixiv.net') {
      const m = u.pathname.match(/\/artworks\/(\d+)/);
      return m?.[1] || '';
    }

    if (u.hostname === 'i.pximg.net') {
      const m = u.pathname.match(/\/(\d+)_p\d+/);
      return m?.[1] || '';
    }

    return '';
  }

  function getExcludeIllustIds() {
    const id = parseIllustIdFromUrl(location.href);
    return id ? [id] : [];
  }

  /**
   * Determine tag context for a given URL.
   *
   * Rules:
   * - If we can parse a non-empty tag, it's explicit.
   * - If we're on the bookmarks list page and there is no tag, that's explicitly "all" (empty tag) and is explicit.
   * - Otherwise, we don't know (context), and we let the background reuse the per-tab context.
   */
  function getTagReqForUrl(urlStr) {
    const parsedTag = parseTagFromUrl(urlStr);

    if (parsedTag) {
      return { tagName: parsedTag, tagNameMode: 'explicit' };
    }

    if (isBookmarksListUrl(urlStr)) {
      return { tagName: '', tagNameMode: 'explicit' };
    }

    return { tagName: null, tagNameMode: 'context' };
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || '扩展通信失败'));
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function ensureButton() {
    // IMPORTANT: document.getElementById only finds elements already in DOM.
    // We keep a strong reference so we don't accidentally create duplicates
    // before the first rAF append happens.
    if (STATE.btnEl) {
      // If Pixiv re-render removed it, re-append.
      if (!STATE.btnEl.isConnected) {
        const tryReappend = () => {
          if (STATE.btnEl.isConnected) return;
          if (document.body) {
            document.body.appendChild(STATE.btnEl);
            return;
          }
          requestAnimationFrame(tryReappend);
        };
        requestAnimationFrame(tryReappend);
      }
      return STATE.btnEl;
    }

    let btn = document.getElementById(BTN_ID);
    if (btn) {
      STATE.btnEl = btn;
      return btn;
    }

    btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';

    Object.assign(btn.style, {
      position: 'fixed',
      right: '24px',
      bottom: '24px',
      zIndex: '2147483647',
      padding: '10px 14px',
      background: '#0096fa',
      color: '#fff',
      border: 'none',
      borderRadius: '999px',
      cursor: 'pointer',
      fontSize: '14px',
      boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
      userSelect: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      lineHeight: '1',
    });

    btn.addEventListener('mouseenter', () => { btn.style.filter = 'brightness(0.95)'; });
    btn.addEventListener('mouseleave', () => { btn.style.filter = ''; });
    btn.addEventListener('click', onClick);

    const tryAppend = () => {
      if (btn.isConnected) return;
      if (document.body) {
        document.body.appendChild(btn);
        return;
      }
      requestAnimationFrame(tryAppend);
    };
    requestAnimationFrame(tryAppend);

    STATE.btnEl = btn;
    renderButton();
    return btn;
  }

  function renderButton() {
    const btn = ensureButton();
    const dots = STATE.ready.filter(Boolean).length;
    const base = STATE.uiBusy ? BTN_LABEL_BUSY : BTN_LABEL;
    btn.textContent = dots > 0 ? `${base} ${'•'.repeat(dots)}` : base;

    btn.disabled = STATE.uiBusy;
    btn.style.cursor = STATE.uiBusy ? 'default' : 'pointer';
    btn.style.opacity = STATE.uiBusy ? '0.85' : '1';

    btn.title = STATE.uiError || 'Random from Pixiv bookmarks';
  }

  function clearLocalBuffer() {
    STATE.queue = Array(BUFFER_SIZE).fill(null);
    STATE.ready = Array(BUFFER_SIZE).fill(false);
    STATE.preloaders = Array(BUFFER_SIZE).fill(null);
    renderButton();
  }

  async function doEnsurePrefetchBuffer(tagReq) {
    const excludeIllustIds = getExcludeIllustIds();

    const resp = await sendMessage({
      type: 'ENSURE_BUFFER',
      tagName: tagReq.tagName,
      tagNameMode: tagReq.tagNameMode,
      size: BUFFER_SIZE,
      excludeIllustIds,
    });

    if (!resp || !resp.ok || !Array.isArray(resp.queue)) {
      throw new Error(resp?.error || '无法准备预加载图片。');
    }

    const nextQueue = resp.queue.slice(0, BUFFER_SIZE);

    // If background resolved context tag, we can refresh lastExplicitTag only when request was explicit.
    // Otherwise, keep lastExplicitTag unchanged.
    if (tagReq.tagNameMode === 'explicit') {
      STATE.lastExplicitTag = (typeof tagReq.tagName === 'string') ? tagReq.tagName : '';
    }

    for (let i = 0; i < BUFFER_SIZE; i++) {
      const oldUrl = STATE.queue?.[i]?.url;
      const newCand = nextQueue[i] || null;

      if (!newCand) {
        STATE.queue[i] = null;
        STATE.ready[i] = false;
        STATE.preloaders[i] = null;
        continue;
      }

      if (oldUrl && oldUrl === newCand.url) {
        // Keep existing preloader/ready state.
        STATE.queue[i] = newCand;
        continue;
      }

      STATE.queue[i] = newCand;
      STATE.ready[i] = false;

      const img = new Image();
      STATE.preloaders[i] = img;

      img.onload = () => {
        if (STATE.preloaders[i] === img && STATE.queue?.[i]?.url === newCand.url) {
          STATE.ready[i] = true;
          renderButton();
        }
      };
      img.onerror = () => {
        if (STATE.preloaders[i] === img && STATE.queue?.[i]?.url === newCand.url) {
          STATE.ready[i] = false;
          renderButton();
        }
      };

      img.src = newCand.url;
    }

    renderButton();
  }

  /**
   * Coalesce multiple ensure requests; always run the latest requested one.
   * @param {TagReq} tagReq
   */
  function ensurePrefetchBuffer(tagReq) {
    STATE.pendingEnsureReq = tagReq;
    if (STATE.ensureInFlight) return STATE.ensureInFlight;

    STATE.ensureInFlight = (async () => {
      while (STATE.pendingEnsureReq) {
        const req = STATE.pendingEnsureReq;
        STATE.pendingEnsureReq = null;
        await doEnsurePrefetchBuffer(req);
      }
    })().catch((e) => {
      // Non-fatal: keep button usable, but surface the error in tooltip.
      STATE.uiError = (e instanceof Error) ? e.message : String(e);
      renderButton();
    }).finally(() => {
      STATE.ensureInFlight = null;
    });

    return STATE.ensureInFlight;
  }

  async function onClick() {
    if (STATE.uiBusy) return;

    STATE.uiBusy = true;
    STATE.uiError = '';
    renderButton();

    const tagReq = getTagReqForUrl(location.href);
    const excludeIllustIds = getExcludeIllustIds();

    // Fallback if messaging fails (best-effort): use locally prefetched first slot.
    const localFallbackUrl = STATE.queue?.[0]?.url || '';

    try {
      const resp = await sendMessage({
        type: 'CONSUME_BUFFER',
        tagName: tagReq.tagName,
        tagNameMode: tagReq.tagNameMode,
        size: BUFFER_SIZE,
        excludeIllustIds,
      });

      if (resp?.ok && resp?.candidate?.url) {
        location.href = resp.candidate.url;
        return;
      }

      // Slow fallback
      const resp2 = await sendMessage({
        type: 'GET_RANDOM_NOW',
        tagName: tagReq.tagName,
        tagNameMode: tagReq.tagNameMode,
        excludeIllustIds,
      });
      if (resp2?.ok && resp2?.candidate?.url) {
        location.href = resp2.candidate.url;
        return;
      }

      if (localFallbackUrl) {
        location.href = localFallbackUrl;
        return;
      }

      throw new Error(resp2?.error || resp?.error || '随机失败。');
    } catch (e) {
      STATE.uiError = (e instanceof Error) ? e.message : String(e);
    } finally {
      // If navigation happens, this may not visibly apply; but it keeps the UI sane on failures.
      STATE.uiBusy = false;
      renderButton();
    }
  }

  function startPersistenceLoop() {
    if (!document.documentElement) {
      requestAnimationFrame(startPersistenceLoop);
      return;
    }

    const obs = new MutationObserver(() => {
      if (!document.getElementById(BTN_ID)) ensureButton();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    STATE.lastHref = location.href;
    const initialReq = getTagReqForUrl(location.href);
    if (initialReq.tagNameMode === 'explicit') {
      STATE.lastExplicitTag = initialReq.tagName ?? '';
    }

    setInterval(() => {
      if (location.href === STATE.lastHref) return;
      STATE.lastHref = location.href;

      const req = getTagReqForUrl(location.href);
      if (req.tagNameMode === 'explicit') {
        const nextExplicit = req.tagName ?? '';
        // Clear buffer when explicit context changes (including switching to "all").
        if (STATE.lastExplicitTag === undefined || nextExplicit !== STATE.lastExplicitTag) {
          STATE.lastExplicitTag = nextExplicit;
          clearLocalBuffer();
        }
      }

      ensurePrefetchBuffer(req);
    }, 500);
  }

  function boot() {
    ensureButton();
    startPersistenceLoop();

    const initialReq = getTagReqForUrl(location.href);
    ensurePrefetchBuffer(initialReq);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        ensurePrefetchBuffer(getTagReqForUrl(location.href));
      }
    });
  }

  boot();
})();
