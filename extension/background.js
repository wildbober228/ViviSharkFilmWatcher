// Routes commands from the FilmWatcher tab to the tab where the movie is playing.
// State lives in storage.session because the service worker can be stopped between messages.
const load = () => chrome.storage.session.get(['target', 'site']);
const save = (values) => chrome.storage.session.set(values);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId == null || !msg) return;
  if (msg.type === 'hello') save({ site: tabId });
  if (msg.type === 'state') onState(tabId, msg.playing);
  if (msg.type === 'cmd') {
    run(tabId, msg.cmd).then(sendResponse);
    return true; // answer asynchronously
  }
});

async function onState(tabId, playing) {
  const { target, site } = await load();
  // The movie is wherever a real video last started playing.
  if (playing && tabId !== target) await save({ target: tabId });
  if (site != null && (playing || tabId === target)) {
    chrome.tabs.sendMessage(site, { type: 'state', playing }).catch(() => {});
  }
}

async function run(site, cmd) {
  await save({ site });
  const { target } = await load();
  const audible = (await chrome.tabs.query({ audible: true })).map((t) => t.id);
  const candidates = [...new Set([target, ...audible])].filter((id) => id != null && id !== site);
  for (const id of candidates) {
    try {
      const result = await chrome.tabs.sendMessage(id, { cmd });
      if (result?.ok) {
        await save({ target: id });
        return result;
      }
    } catch {
      // tab closed, or a page the extension can't run on — try the next one
    }
  }
  return { ok: false, error: 'no-video' };
}
