// Runs in every frame of every other site: finds the movie's <video> and obeys play / pause / seek.
(() => {
  const area = (v) => {
    const r = v.getBoundingClientRect();
    return r.width * r.height;
  };
  // Muted thumbnails and hover previews aren't "the movie".
  const isMovie = (v) => !v.muted || area(v) >= 320 * 180;

  const pick = () => {
    const videos = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0 && isMovie(v));
    if (!videos.length) return null;
    return videos.find((v) => !v.paused) ?? videos.sort((a, b) => area(b) - area(a))[0];
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.cmd) return;
    const v = pick();
    if (!v) return; // stay silent so the frame that does have the video answers
    try {
      if (msg.cmd === 'toggle') {
        if (v.paused) v.play()?.catch(() => {});
        else v.pause();
      } else if (msg.cmd === 'back' || msg.cmd === 'fwd') {
        const end = Number.isFinite(v.duration) ? v.duration : Infinity;
        v.currentTime = Math.max(0, Math.min(end, v.currentTime + (msg.cmd === 'back' ? -10 : 10)));
      }
    } catch {
      /* some players guard their element; nothing else to try */
    }
    sendResponse({ ok: true, playing: !v.paused });
  });

  // Tell the extension where the movie plays and when it pauses, so the partner's button stays in sync.
  const report = (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !isMovie(v)) return;
    try {
      chrome.runtime.sendMessage({ type: 'state', playing: e.type === 'play' }).catch(() => {});
    } catch {
      /* extension was reloaded; this old script is orphaned */
    }
  };
  document.addEventListener('play', report, true);
  document.addEventListener('pause', report, true);
})();
