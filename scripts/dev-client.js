(() => {
  const script = document.currentScript;
  const generation = decodeURIComponent(script.dataset.generation);
  const storageKey = `docs-preview-position:${location.pathname}`;
  let reloading = false;
  let notice;
  let events;

  function showError(message) {
    if (!notice) {
      notice = document.createElement('pre');
      notice.id = 'docs-dev-error';
      notice.setAttribute('role', 'alert');
      notice.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;z-index:2147483647;' +
        'max-height:40vh;overflow:auto;margin:0;padding:16px;background:#351b1b;color:#fff;' +
        'border:2px solid #ff9d9d;border-radius:6px;white-space:pre-wrap;font:14px/1.5 monospace;';
      document.body.append(notice);
    }
    notice.textContent = message;
  }

  function storage(method, value) {
    try {
      return sessionStorage[method](storageKey, value);
    } catch (error) {
      const unavailable = ['SecurityError', 'QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(error?.name);
      console.warn(unavailable
        ? 'Documentation preview: session storage is unavailable; scroll restoration may be lost.'
        : `Documentation preview: unexpected session storage ${method} failure; scroll restoration may be lost.`, error);
      return null;
    }
  }

  const savedText = storage('getItem');
  if (savedText !== null) {
    storage('removeItem');
    let saved;
    try {
      saved = JSON.parse(savedText);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.warn('Documentation preview: discarding malformed saved scroll position.', error);
    }
    if (saved !== undefined) {
      if (!saved || typeof saved.hash !== 'string' || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
        console.warn('Documentation preview: discarding invalid saved scroll position.', saved);
      } else if (saved.hash === location.hash) {
        const restore = () => requestAnimationFrame(() => requestAnimationFrame(() => scrollTo(saved.x, saved.y)));
        if (document.readyState === 'complete') restore();
        else window.addEventListener('load', restore, { once: true });
      }
    }
  }

  function receive(event) {
    if (!('data' in event)) {
      showError('Documentation preview disconnected. Reconnecting automatically…');
      return;
    }
    let state;
    try {
      state = JSON.parse(event.data);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.warn('Documentation preview: malformed live-reload JSON.', error);
      showError('Documentation preview received invalid JSON from the live-reload server. See the browser console for details.');
      return;
    }
    if (!state || typeof state.generation !== 'string' || !state.generation ||
        (state.error !== null && typeof state.error !== 'string')) {
      console.warn('Documentation preview: invalid live-reload event state.', state);
      showError('Documentation preview received an invalid live-reload event. See the browser console for details.');
      return;
    }
    if (state.generation !== generation) {
      if (reloading) return;
      reloading = true;
      storage('setItem', JSON.stringify({ x: scrollX, y: scrollY, hash: location.hash }));
      events.close();
      location.reload();
      return;
    }
    if (state.error) showError(`Documentation build failed — showing the last successful page.\n\n${state.error}`);
    else {
      notice?.remove();
      notice = undefined;
    }
  }
  function connect() {
    events?.close();
    events = new EventSource('/__docs/events');
    events.addEventListener('built', receive);
    events.addEventListener('error', receive);
  }
  connect();
  window.addEventListener('pagehide', () => events.close());
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      reloading = false;
      connect();
    }
  });
})();
