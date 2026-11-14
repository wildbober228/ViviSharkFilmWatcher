# FilmWatcher for ViviShark

Movie night and browsing together: one person shares a browser tab or a movie from their computer, the other watches on a phone, and both cameras float as small windows over the picture, even in fullscreen.

Everything runs browser-to-browser (WebRTC via PeerJS). There's no backend; it's a static site for GitHub Pages.

## How to use

**The one sharing (computer, Chrome or Edge):**

1. Open the site → "Create a room" → copy the link and send it. The link never changes.
2. **Float on top**: the other camera in a small window that stays above every window, even a fullscreen movie.
3. **Screen**: pick a tab and keep "Share tab audio" on. The "Movie / Browse" button switches between smooth motion and sharp text.
4. **File**: a movie from your computer (MP4 H.264 + AAC works best). Better quality, cameras inside the player, and the other viewer can pause too.

**The one watching (iPhone, Safari):** open the link → "Join the room" → allow camera and microphone. For true fullscreen: Share → Add to Home Screen, then open the room from that icon.

Camera windows can be dragged; double-tap to resize. Keyboard on desktop: Space play/pause, ←/→ 10 seconds, M mic, V camera, F fullscreen, 1–6 reactions.

## Connection servers

Devices find each other through public servers, then video goes directly between them. Settings → **Connection server**:

- **Auto** (default): tries all routes at once and uses whichever connects first.
- **PeerJS**: fastest, but its server sits behind Cloudflare, which is throttled in Russia without a VPN.
- **Nostr relays** / **MQTT brokers**: public servers that are not behind Cloudflare. Offers are encrypted with the room code.

**Test servers** shows which routes the current device can reach.

## Limitations

- Netflix, Prime, Disney+ and other DRM services show a black screen when captured. YouTube, most sites and local files work.
- An iPhone can't share its own screen from the browser (Safari limitation), only watch.
- If the call never connects (strict NAT on mobile networks), add your own TURN server in Settings, e.g. a free one from metered.ca.

## Development

```bash
npm install
npm run dev
```

Deploy: push to `main` → GitHub Actions builds and publishes to Pages (Settings → Pages → Source: GitHub Actions).
