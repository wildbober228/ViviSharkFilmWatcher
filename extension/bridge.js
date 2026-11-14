// Runs on the FilmWatcher page: relays commands between the page and the extension.
// Page → extension: { fwr: 'page', type: 'ping' | 'cmd', id, cmd }
// Extension → page: { fwr: 'ext', type: 'hello' | 'result' | 'state', ... }
(() => {
  const toPage = (data) => window.postMessage({ fwr: 'ext', ...data }, location.origin);

  const hello = () => {
    toPage({ type: 'hello', version: chrome.runtime.getManifest().version });
    chrome.runtime.sendMessage({ type: 'hello' }).catch(() => {});
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.fwr !== 'page') return;
    if (e.data.type === 'ping') hello();
    if (e.data.type === 'cmd') {
      const id = e.data.id;
      chrome.runtime
        .sendMessage({ type: 'cmd', cmd: e.data.cmd })
        .then((result) => toPage({ type: 'result', id, ...(result ?? { ok: false, error: 'no-video' }) }))
        .catch(() => toPage({ type: 'result', id, ok: false, error: 'extension' }));
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'state') toPage({ type: 'state', playing: !!msg.playing });
  });

  hello();
})();
