import './style.css';
import { Bubble } from './bubble';
import { paintIcons, setIcon } from './icons';
import type { LinkStatus, Msg, Role, ScreenKind } from './link';
import {
  LocalMedia,
  QUALITY,
  captureDisplay,
  captureFromVideo,
  deviceProblem,
  type QualityKey,
  type ViewMode,
} from './media';
import { REACTIONS, spawnReaction } from './reactions';
import { RemoteControl, type RemoteCmd } from './remote';
import { ROUTES, ROUTE_CHOICES, checkRoutes, routesFor, type RouteChoice } from './routes';
import { StatsMonitor } from './stats';
import { newCode, parseCode, store } from './store';
import { Switchboard } from './switchboard';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const lobby = $('lobby');
const room = $('room');
const stage = $('stage');
const main = $<HTMLVideoElement>('main');
const notice = $('notice');
const partnerBubbleEl = $('partnerBubble');
const partnerCam = $('partnerCam');
const partnerVideo = $<HTMLVideoElement>('partnerVideo');
const selfBubbleEl = $('selfBubble');
const selfCam = $('selfCam');
const selfVideo = $<HTMLVideoElement>('selfVideo');
const reactLayer = $('reactLayer');
const invite = $('invite');
const inviteLink = $<HTMLInputElement>('inviteLink');
const pipPrompt = $('pipPrompt');
const soundUnlock = $('soundUnlock');
const hud = $('hud');
const controls = $('controls');
const fileBar = $('fileBar');
const seekBar = $<HTMLInputElement>('fpSeek');
const volBar = $<HTMLInputElement>('fpVol');
const settingsDlg = $<HTMLDialogElement>('settings');
const camSel = $<HTMLSelectElement>('camSel');
const micSel = $<HTMLSelectElement>('micSel');
const qualSel = $<HTMLSelectElement>('qualSel');
const routeSel = $<HTMLSelectElement>('routeSel');
const selfChk = $<HTMLInputElement>('selfChk');
const partnerChk = $<HTMLInputElement>('partnerChk');
const chatBtn = $('chatBtn');
const chatPanel = $('chatPanel');
const chatMessages = $('chatMessages');
const chatInput = $<HTMLInputElement>('chatInput');
const chatSend = $<HTMLButtonElement>('chatSend');
const turnInput = $<HTMLTextAreaElement>('turnInput');
const fileInput = $<HTMLInputElement>('fileInput');
const btn = {
  mic: $('micBtn'),
  cam: $('camBtn'),
  share: $('shareBtn'),
  file: $('fileBtn'),
  mode: $('modeBtn'),
  pip: $('pipBtn'),
  fit: $('fitBtn'),
  fs: $('fsBtn'),
  stats: $('statsBtn'),
  play: $('fpPlay'),
};

// ---------------------------------------------------------------- environment

const isIOS =
  /iP(hone|od|ad)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const standalone =
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  matchMedia('(display-mode: standalone)').matches;
const canShareScreen = !isIOS && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
const hoverCapable = matchMedia('(hover: hover)').matches;

// ---------------------------------------------------------------- state

const urlCode = parseCode(new URLSearchParams(location.search).get('r') ?? '');
const lastJoin = store.get('lastJoin');
// A phone opened from its home-screen icon (no ?r=) goes back to the last room it joined.
let role: Role = urlCode || (!canShareScreen && lastJoin) ? 'guest' : 'host';
let code = role === 'guest' ? urlCode || lastJoin : store.get('hostCode') || newCode();

let media: LocalMedia | null = null;
let link: Switchboard | null = null;
const remote = new RemoteControl(() => {
  renderRemoteStatus();
  if (!link) return;
  sendState();
  updateLayout();
});
const savedRoute = store.get('route', 'auto') as RouteChoice;
let routeChoice: RouteChoice = savedRoute in ROUTE_CHOICES ? savedRoute : 'auto';
let status: LinkStatus = 'server';
let statusDetail = '';
let partnerStream: MediaStream | null = null;
let remoteScreen: MediaStream | null = null;
const PARTNER_DEFAULT = { cam: true, mic: true, screen: false as ScreenKind | false, playing: false, remote: false };
let partner = { ...PARTNER_DEFAULT };
let screenKind: ScreenKind | null = null;
let screenStream: MediaStream | null = null;
let screenHeight = 0;
let fileUrl = '';
let seeking = false;
let mode: ViewMode = store.get('mode') === 'browse' ? 'browse' : 'movie';
let quality = store.get('quality', 'high') as QualityKey;
if (!(quality in QUALITY)) quality = 'high';
let selfView = store.get('selfView', '1') === '1';
let hidePartner = store.get('hidePartner') === '1';
let inviteDismissed = false;
let inviteForced = false;
let pipWin: Window | null = null;
let statsOn = false;

const partnerBubble = new Bubble(partnerBubbleEl, stage, 'partner', { x: 1, y: 0, level: 1 });
const selfBubble = new Bubble(selfBubbleEl, stage, 'self', { x: 0, y: 1, level: 0 });
for (const [video, bubble] of [
  [partnerVideo, partnerBubble],
  [selfVideo, selfBubble],
] as const) {
  const sync = () => video.videoWidth && bubble.setAspect(video.videoWidth / video.videoHeight);
  video.addEventListener('loadedmetadata', sync);
  video.addEventListener('resize', sync);
}

const STATUS_TEXT: Record<Role, Record<LinkStatus, string>> = {
  host: {
    server: 'Connecting to the server…',
    waiting: 'Waiting for the other viewer',
    connecting: 'Connecting…',
    connected: 'Connected',
    error: 'Connection problem',
  },
  guest: {
    server: 'Connecting to the server…',
    waiting: 'The room isn’t open yet — waiting for it',
    connecting: 'Connecting…',
    connected: 'Connected',
    error: 'Connection problem',
  },
};

// ---------------------------------------------------------------- helpers

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return '0:00';
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

let lastToast = '';
function toast(text: string, ms = 3500): void {
  if (text === lastToast) return;
  lastToast = text;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
    if (lastToast === text) lastToast = '';
  }, ms);
}

function playSafe(video: HTMLVideoElement): void {
  video.play().catch((e: DOMException) => {
    if (e.name === 'NotAllowedError' && !video.muted) soundUnlock.hidden = false;
  });
}

function clearMain(): void {
  main.pause();
  main.srcObject = null;
  main.removeAttribute('src');
  main.load();
}

function inviteUrl(): string {
  return `${location.origin}${location.pathname}?r=${code}`;
}

// ---------------------------------------------------------------- lobby

function setupLobby(): void {
  $('hostLobby').hidden = role !== 'host';
  $('guestLobby').hidden = role !== 'guest';
  if (role === 'host') {
    const known = !!store.get('hostCode');
    $('createBtn').textContent = known ? 'Open my room' : 'Create a room';
    $('roomHint').textContent = known
      ? `Room ${code} — same link as before`
      : 'You’ll get a link for the other viewer right after creating it';
    if (!canShareScreen) $('roomHint').textContent += '. Phones can’t share the screen — video call only.';
  } else {
    $('lobbyTitle').textContent = 'You’re invited to watch together 🍿';
    $('lobbyText').textContent =
      'The other viewer will share a movie or a browser tab, and both cameras will float right over the picture.';
  }
  $('iosTip').hidden = !(isIOS && !standalone);
}

function lobbyError(text: string): void {
  const el = $('lobbyError');
  el.textContent = text;
  el.hidden = false;
}

$('createBtn').addEventListener('click', () => {
  store.set('hostCode', code);
  void enterRoom();
});
$('joinBtn').addEventListener('click', () => {
  store.set('lastJoin', code);
  void enterRoom();
});
$('codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = parseCode($<HTMLInputElement>('codeInput').value);
  if (!c) return lobbyError('That doesn’t look like a room code or link.');
  role = 'guest';
  code = c;
  history.replaceState(null, '', `?r=${c}`);
  store.set('lastJoin', c);
  void enterRoom();
});

async function enterRoom(): Promise<void> {
  lobby.querySelectorAll('button').forEach((b) => (b.disabled = true));
  media = new LocalMedia();
  const warn = await media.init(store.get('cam') || undefined, store.get('mic') || undefined);

  document.body.classList.add('in-room', `role-${role}`);
  lobby.hidden = true;
  room.hidden = false;
  btn.share.hidden = !canShareScreen;
  selfVideo.srcObject = media.stream;
  playSafe(selfVideo);
  if (warn) toast(warn, 9000);
  inviteLink.value = inviteUrl();
  renderMediaButtons();
  renderMode();
  renderStatus();
  updateLayout();
  wake();

  await connect();
  void keepAwake();
}

/** (Re)start the connection with the routes picked in Settings; camera and movie keep running. */
async function connect(): Promise<void> {
  if (link) {
    link.destroy();
    link = null;
    linkEvents.partner(null);
    if (role === 'guest') linkEvents.screen(null);
    linkEvents.status('server');
  }
  const ice = await loadIce();
  link = new Switchboard(role, code, () => media!.stream, linkEvents, ice, routesFor(routeChoice));
  link.setQuality(quality);
  if (screenStream) link.setScreen(screenStream, screenHeight);
  link.start();
}

async function loadIce(): Promise<RTCIceServer[]> {
  const raw = store.get('turn').trim();
  if (!raw) return [];
  try {
    const data = raw.startsWith('http') ? await (await fetch(raw)).json() : JSON.parse(raw);
    const list: RTCIceServer[] = Array.isArray(data) ? data : (data?.iceServers ?? [data]);
    return list.filter((s) => s && s.urls);
  } catch (e) {
    toast('Couldn’t load the TURN settings: ' + errText(e), 7000);
    return [];
  }
}

// ---------------------------------------------------------------- link events

const linkEvents = {
  status(s: LinkStatus, detail?: string) {
    status = s;
    statusDetail = detail ?? '';
    if (s === 'connected') sendState();
    else partner = { ...PARTNER_DEFAULT };
    renderStatus();
    updateLayout();
    chatSend.disabled = s !== 'connected';
    $('chatStatus').hidden = s === 'connected';
  },
  partner(stream: MediaStream | null) {
    partnerStream = stream;
    partnerVideo.srcObject = stream;
    if (stream) playSafe(partnerVideo);
    updateLayout();
  },
  screen(stream: MediaStream | null) {
    remoteScreen = stream;
    if (stream) {
      main.srcObject = stream;
      main.muted = false;
      playSafe(main);
    } else if (role === 'guest') {
      clearMain();
    }
    updateLayout();
  },
  message: onMessage,
};

function sendState(): void {
  if (!media || !link) return;
  link.send({
    t: 'state',
    cam: media.camOn,
    mic: media.micOn,
    screen: role === 'host' ? (screenKind ?? false) : false,
    // A shared tab's state is only known once the Remote extension reports it; assume it's playing.
    playing: screenKind === 'file' ? !main.paused : screenKind === 'share' && (remote.playing ?? true),
    remote: role === 'host' && remote.available,
  });
}

function onMessage(m: Msg): void {
  switch (m.t) {
    case 'state':
      partner = { cam: m.cam, mic: m.mic, screen: m.screen, playing: !!m.playing, remote: !!m.remote };
      if (role === 'guest' && !m.screen && remoteScreen) linkEvents.screen(null);
      updateLayout();
      break;
    case 'react':
      react(m.e, false);
      break;
    case 'chat':
      if (typeof m.text === 'string' && m.text.length <= chatInput.maxLength && m.text.trim()) {
        appendChat(m.text.trim(), false);
      }
      break;
    case 'ctl':
      if (role !== 'host') break;
      if (m.a === 'toggle-play') togglePlay(true);
      else seekBy(m.a === 'back' ? -10 : 10, true);
      break;
    case 'note':
      toast(m.text, 6000);
      break;
  }
}

/** Guest: can the host's movie be paused from here (a file, or a shared tab with the Remote extension)? */
const partnerControllable = () => partner.screen === 'file' || (partner.screen === 'share' && partner.remote);

/** Host: play/pause/seek the shared tab through the Remote extension. */
async function remoteCtl(cmd: RemoteCmd, fromPartner: boolean): Promise<void> {
  const result = await remote.send(cmd);
  if (result.ok) return sendState();
  const why =
    result.error === 'no-video'
      ? 'no playing video found in your tabs'
      : 'the Remote extension didn’t answer — reload the movie tab';
  toast(`Couldn’t control the shared tab: ${why}`, 6000);
  if (fromPartner) link?.send({ t: 'note', text: 'Couldn’t reach the video on the other side — ask them to check the movie tab.' });
}

// ---------------------------------------------------------------- rendering

function renderStatus(): void {
  const via = link?.activeRoute;
  $('statusText').textContent =
    statusDetail || STATUS_TEXT[role][status] + (status === 'connected' && via ? ` · via ${ROUTES[via].label}` : '');
  const tone = { connected: 'ok', waiting: 'wait', connecting: 'wait', server: '', error: 'err' }[status];
  $('statusDot').className = `dot ${tone}`;
}

function renderMediaButtons(): void {
  if (!media) return;
  const rows = [
    [btn.mic, media.micOn, 'mic', 'Microphone on', 'Microphone off'],
    [btn.cam, media.camOn, 'cam', 'Camera on', 'Camera off'],
    [pipMic, media.micOn, 'mic', 'Microphone on', 'Microphone off'],
  ] as const;
  for (const [b, on, name, onLabel, offLabel] of rows) {
    setIcon(b, on ? name : `${name}Off`);
    b.classList.toggle('off', !on);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? onLabel : offLabel);
  }
  selfCam.classList.toggle('off', !media.camOn);
}

function renderRemoteStatus(): void {
  const el = $('remoteStatus');
  el.classList.toggle('ok', remote.available);
  el.textContent = remote.available
    ? `✓ Remote extension ${remote.version} is on — the other side can pause and skip a shared tab.`
    : 'To let the other side pause a shared tab (Screen mode), install the FilmWatcher Remote extension in this Chrome — see the README.';
}

function renderMode(): void {
  setIcon(btn.mode, mode === 'movie' ? 'movie' : 'browse');
  btn.mode.querySelector('.lbl')!.textContent = mode === 'movie' ? 'Movie' : 'Browse';
}

function renderFullscreen(): void {
  const d = document as Document & { webkitFullscreenElement?: Element };
  setIcon(btn.fs, d.fullscreenElement || d.webkitFullscreenElement ? 'shrink' : 'expand');
}

function updateLayout(): void {
  const connected = status === 'connected';
  const hasMain = role === 'host' ? screenKind !== null : remoteScreen !== null;
  stage.classList.toggle('has-main', hasMain);

  partnerBubbleEl.hidden = hidePartner || !connected || !!pipWin;
  partnerBubbleEl.classList.toggle('fill', !hasMain);
  partnerCam.classList.toggle('off', !partnerStream || !partner.cam);
  partnerCam.querySelector('.cam-off span')!.textContent = partnerStream ? 'camera is off' : 'connecting camera…';
  $('partnerMicOff').hidden = !connected || partner.mic;
  selfBubbleEl.hidden = !selfView;
  selfCam.classList.toggle('off', !media?.camOn);
  partnerBubble.layout();
  selfBubble.layout();

  if (role === 'host') invite.hidden = !(inviteForced || (!connected && !inviteDismissed));

  let text = '';
  if (!connected) {
    if (role === 'guest') text = statusDetail || STATUS_TEXT.guest[status];
    else if (invite.hidden && !hasMain) text = 'Waiting for the other viewer…';
  } else if (!hasMain && pipWin) {
    text = 'The other camera is in the floating window';
  }
  $('noticeText').textContent = text;
  notice.hidden = !text;
  notice.classList.toggle('busy', !connected);

  const fileMode = role === 'host' ? screenKind === 'file' : hasMain && partnerControllable();
  fileBar.hidden = !fileMode;
  setIcon(btn.play, (role === 'host' ? !main.paused : partner.playing) ? 'pause' : 'play');

  if (role === 'host') {
    const sharing = screenKind === 'share';
    setIcon(btn.share, sharing ? 'stopShare' : 'share');
    btn.share.querySelector('.lbl')!.textContent = sharing ? 'Stop' : 'Screen';
    btn.share.classList.toggle('active', sharing);
    btn.file.classList.toggle('active', screenKind === 'file');
    btn.pip.classList.toggle('active', !!pipWin);
    btn.pip.hidden = hidePartner;
  }
  btn.fit.hidden = !hasMain;
}

// ---------------------------------------------------------------- room chat

function appendChat(text: string, mine: boolean): void {
  const atBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 24;
  const message = document.createElement('p');
  message.className = mine ? 'chat-message mine' : 'chat-message';
  const sender = document.createElement('strong');
  sender.textContent = mine ? 'You' : 'Other viewer';
  message.append(sender, document.createTextNode(text));
  chatMessages.append(message);
  if (chatMessages.childElementCount > 300) chatMessages.firstElementChild?.remove();
  if (mine || atBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
  if (chatPanel.hidden && !mine) {
    chatBtn.classList.add('unread');
    chatBtn.setAttribute('aria-label', 'Chat, new messages');
  }
}

function showChat(open: boolean): void {
  chatPanel.hidden = !open;
  chatBtn.setAttribute('aria-expanded', String(open));
  chatBtn.classList.toggle('active', open);
  if (open) {
    chatBtn.classList.remove('unread');
    chatBtn.setAttribute('aria-label', 'Chat');
    chatMessages.scrollTop = chatMessages.scrollHeight;
    $('chatClose').focus();
  } else {
    chatBtn.focus();
  }
  wake();
}

chatBtn.addEventListener('click', () => showChat(chatPanel.hasAttribute('hidden')));
$('chatClose').addEventListener('click', () => showChat(false));
chatPanel.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') showChat(false);
  event.stopPropagation();
});
$('chatForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || text.length > chatInput.maxLength || !link?.connected) return;
  link.send({ t: 'chat', text });
  appendChat(text, true);
  chatInput.value = '';
  chatInput.focus();
});

// ---------------------------------------------------------------- reactions

const pipRoot = document.createElement('div');
pipRoot.className = 'pip-root';
const pipReact = document.createElement('div');
pipReact.className = 'react-layer';
const pipBar = document.createElement('div');
pipBar.className = 'bar pip-bar';
const pipMic = document.createElement('button');
pipMic.className = 'icon-btn';
pipMic.addEventListener('click', () => toggleMic());
pipBar.append(pipMic);
pipRoot.append(pipReact, pipBar);

REACTIONS.forEach((emoji, i) => {
  for (const [bar, max] of [
    [$('reactBar'), REACTIONS.length],
    [pipBar, 4],
  ] as const) {
    if (i >= max) continue;
    const b = document.createElement('button');
    b.className = 'icon-btn react-btn';
    b.textContent = emoji;
    b.title = bar === pipBar ? emoji : `${emoji} (${i + 1})`;
    b.addEventListener('click', () => react(emoji, true));
    bar.append(b);
  }
});

function react(emoji: string, mine: boolean): void {
  for (const layer of [reactLayer, pipReact]) if (layer.isConnected) spawnReaction(layer, emoji, mine);
  if (emoji === '😱') {
    stage.classList.remove('shake');
    void stage.offsetWidth;
    stage.classList.add('shake');
  }
  if (mine) link?.send({ t: 'react', e: emoji });
  else navigator.vibrate?.(emoji === '😱' ? [60, 40, 90] : 30);
}
stage.addEventListener('animationend', (e) => e.target === stage && stage.classList.remove('shake'));

// ---------------------------------------------------------------- mic / cam / devices

function toggleMic(): void {
  if (!media) return;
  // No working mic yet (none plugged in, busy, blocked) — the button retries.
  if (!media.realMic) return void switchDevice('audio');
  media.setMic(!media.micOn);
  renderMediaButtons();
  sendState();
}

function toggleCam(): void {
  if (!media) return;
  if (!media.realCam) return void switchDevice('video');
  media.setCam(!media.camOn);
  renderMediaButtons();
  sendState();
  updateLayout();
}

async function switchDevice(kind: 'video' | 'audio', deviceId?: string): Promise<void> {
  if (!media) return;
  try {
    const track = await media.switchDevice(kind, deviceId);
    link?.replaceTrack(track);
    if (deviceId) store.set(kind === 'video' ? 'cam' : 'mic', deviceId);
    selfVideo.srcObject = media.stream;
    playSafe(selfVideo);
    renderMediaButtons();
    sendState();
    updateLayout();
  } catch (e) {
    toast(deviceProblem(kind === 'video' ? 'camera' : 'microphone', e), 9000);
  }
}

async function fillDevices(): Promise<void> {
  if (!media || !navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel: HTMLSelectElement, kind: MediaDeviceKind, current: string | undefined, name: string) => {
    const list = devices.filter((d) => d.kind === kind && d.deviceId);
    sel.replaceChildren(
      ...list.map((d, i) => new Option(d.label || `${name} ${i + 1}`, d.deviceId, false, d.deviceId === current)),
    );
    if (!list.length) sel.add(new Option('None found', ''));
    sel.disabled = !list.length;
  };
  fill(camSel, 'videoinput', media.realCam ? media.videoTrack?.getSettings().deviceId : undefined, 'Camera');
  fill(micSel, 'audioinput', media.realMic ? media.audioTrack?.getSettings().deviceId : undefined, 'Microphone');
}

// ---------------------------------------------------------------- host: screen & file

async function toggleShare(): Promise<void> {
  if (screenKind === 'share') return stopScreen();
  let stream: MediaStream;
  try {
    stream = await captureDisplay(!!pipWin);
  } catch (e) {
    const name = (e as DOMException).name;
    if (name !== 'NotAllowedError' && name !== 'AbortError') toast('Couldn’t share the screen: ' + errText(e));
    return;
  }
  if (screenKind) stopScreen(false);

  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0];
  if (video) {
    video.contentHint = mode === 'movie' ? 'motion' : 'detail';
    video.addEventListener('ended', () => screenStream === stream && stopScreen());
  }
  if (audio) audio.contentHint = 'music';
  if (!audio) toast('No sound is being shared. When picking a tab, keep “Share tab audio” switched on.', 9000);
  else if (video?.getSettings().displaySurface === 'monitor')
    toast('Sharing the whole screen. If the other side hears an echo of their voice, share a single tab instead.', 9000);

  main.removeAttribute('src');
  main.srcObject = stream;
  main.muted = true;
  playSafe(main);
  setScreen(stream, 'share', video?.getSettings().height ?? 0);
  if (!hidePartner && !pipWin && 'documentPictureInPicture' in window) pipPrompt.hidden = false;
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  if (screenKind) stopScreen(false);
  fileUrl = URL.createObjectURL(file);
  main.srcObject = null;
  main.src = fileUrl;
  main.muted = false;
  main.volume = Number(volBar.value);
  screenKind = 'file';
  updateLayout();
  main.play().catch(() => {});
  try {
    const stream = await captureFromVideo(main);
    if (screenKind !== 'file' || main.src !== fileUrl) return stream.getTracks().forEach((t) => t.stop());
    stream.getVideoTracks().forEach((t) => (t.contentHint = 'motion'));
    stream.getAudioTracks().forEach((t) => (t.contentHint = 'music'));
    setScreen(stream, 'file', main.videoHeight);
    toast(`▶ ${file.name}`);
  } catch (e) {
    toast('Can’t play this file: ' + errText(e) + '. MP4 (H.264 + AAC) works best.', 9000);
    stopScreen();
  }
});

function setScreen(stream: MediaStream, kind: ScreenKind, sourceHeight: number): void {
  screenStream = stream;
  screenHeight = sourceHeight;
  screenKind = kind;
  link?.setScreen(stream, sourceHeight);
  sendState();
  updateLayout();
}

function stopScreen(notify = true): void {
  screenStream?.getTracks().forEach((t) => t.stop());
  if (screenKind) clearMain();
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = '';
  screenStream = null;
  screenKind = null;
  link?.setScreen(null);
  pipPrompt.hidden = true;
  if (notify) {
    sendState();
    updateLayout();
  }
}

function togglePlay(fromPartner = false): void {
  if (role === 'guest') {
    if (partnerControllable()) link?.send({ t: 'ctl', a: 'toggle-play' });
    return;
  }
  if (screenKind === 'share' && remote.available) return void remoteCtl('toggle', fromPartner);
  if (screenKind !== 'file') return;
  if (main.paused) main.play().catch(() => {});
  else main.pause();
}

function seekBy(seconds: number, fromPartner = false): void {
  if (role === 'guest') {
    if (partnerControllable()) link?.send({ t: 'ctl', a: seconds < 0 ? 'back' : 'fwd' });
    return;
  }
  if (screenKind === 'share' && remote.available) return void remoteCtl(seconds < 0 ? 'back' : 'fwd', fromPartner);
  if (screenKind !== 'file' || !Number.isFinite(main.duration)) return;
  main.currentTime = clamp(main.currentTime + seconds, 0, main.duration);
}

function onPlayState(): void {
  if (role !== 'host' || screenKind !== 'file') return;
  sendState();
  updateLayout();
}
main.addEventListener('play', onPlayState);
main.addEventListener('pause', onPlayState);
main.addEventListener('timeupdate', () => {
  if (screenKind !== 'file' || seeking || !main.duration) return;
  seekBar.value = String(Math.round((main.currentTime / main.duration) * 1000));
  $('fpTime').textContent = fmtTime(main.currentTime);
});
main.addEventListener('durationchange', () => ($('fpDur').textContent = fmtTime(main.duration)));
seekBar.addEventListener('input', () => {
  seeking = true;
  if (!Number.isFinite(main.duration)) return;
  main.currentTime = (Number(seekBar.value) / 1000) * main.duration;
  $('fpTime').textContent = fmtTime(main.currentTime);
});
seekBar.addEventListener('change', () => (seeking = false));
volBar.value = store.get('vol', '1');
volBar.addEventListener('input', () => {
  main.volume = Number(volBar.value);
  store.set('vol', volBar.value);
});

function toggleMode(): void {
  mode = mode === 'movie' ? 'browse' : 'movie';
  store.set('mode', mode);
  if (screenKind === 'share') {
    screenStream?.getVideoTracks().forEach((t) => (t.contentHint = mode === 'movie' ? 'motion' : 'detail'));
  }
  renderMode();
  toast(mode === 'movie' ? 'Movie mode: smooth motion first' : 'Browse mode: sharp text first');
}

// ---------------------------------------------------------------- picture-in-picture

async function togglePip(): Promise<void> {
  pipPrompt.hidden = true;
  if (hidePartner) return;
  if (pipWin) return pipWin.close();
  const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow(o: object): Promise<Window> } })
    .documentPictureInPicture;
  if (!dpip) {
    if (document.pictureInPictureEnabled && partnerStream) {
      partnerVideo.requestPictureInPicture().catch((e) => toast('Didn’t work: ' + errText(e)));
    } else {
      toast('The floating window works in Chrome and Edge on a computer');
    }
    return;
  }
  let win: Window;
  try {
    win = await dpip.requestWindow({ width: 360, height: 270 });
  } catch (e) {
    return toast('Couldn’t open the window: ' + errText(e));
  }
  if (hidePartner) return win.close();
  pipWin = win;
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = win.document.createElement('style');
      style.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
      win.document.head.append(style);
    } catch {
      if (!sheet.href) continue;
      const l = win.document.createElement('link');
      l.rel = 'stylesheet';
      l.href = sheet.href;
      win.document.head.append(l);
    }
  }
  win.document.title = 'Camera · FilmWatcher for ViviShark';
  win.document.body.className = 'pip-body';
  pipRoot.prepend(partnerCam);
  win.document.body.append(pipRoot);
  partnerVideo.play().catch(() => {});
  win.addEventListener(
    'pagehide',
    () => {
      partnerBubbleEl.prepend(partnerCam);
      pipRoot.remove();
      partnerVideo.play().catch(() => {});
      pipWin = null;
      updateLayout();
    },
    { once: true },
  );
  updateLayout();
}

// ---------------------------------------------------------------- fullscreen & idle UI

function toggleFullscreen(): void {
  const d = document as Document & {
    webkitFullscreenElement?: Element;
    webkitFullscreenEnabled?: boolean;
    webkitExitFullscreen?: () => void;
  };
  if (d.fullscreenElement) return void d.exitFullscreen().catch(() => {});
  if (d.webkitFullscreenElement) return d.webkitExitFullscreen?.();
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (d.fullscreenEnabled && el.requestFullscreen) {
    el.requestFullscreen({ navigationUI: 'hide' }).catch(() => cinemaFallback());
  } else if (d.webkitFullscreenEnabled && el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
  } else {
    cinemaFallback();
  }
}

/** iPhone Safari can't fullscreen a page — hide the chrome we control and explain the home-screen trick. */
function cinemaFallback(): void {
  goIdle(true);
  if (isIOS && !standalone) {
    toast('On iPhone, true fullscreen works from a home-screen icon: Share → Add to Home Screen. For now, just turn the phone sideways.', 9000);
  }
}
document.addEventListener('fullscreenchange', renderFullscreen);
document.addEventListener('webkitfullscreenchange', renderFullscreen);

let idleTimer = 0;
function wake(): void {
  room.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => goIdle(false), 3500);
}

function goIdle(force: boolean): void {
  const busy =
    settingsDlg.open ||
    !chatPanel.hidden ||
    !invite.hidden ||
    !pipPrompt.hidden ||
    !soundUnlock.hidden ||
    (hoverCapable && (controls.matches(':hover') || hud.matches(':hover')));
  const watching = stage.classList.contains('has-main') || status === 'connected';
  if (!force && (busy || !watching)) {
    // Not yet — look again later, e.g. once the partner connects or the dialog closes.
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => goIdle(false), 3500);
    return;
  }
  room.classList.add('idle');
}

let wasIdle = false;
let pointerType = 'mouse';
document.addEventListener(
  'pointerdown',
  (e) => {
    wasIdle = room.classList.contains('idle');
    pointerType = e.pointerType;
    wake();
  },
  true,
);
document.addEventListener('pointermove', (e) => e.pointerType === 'mouse' && wake());
stage.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.bubble, .card, button, input')) return;
  if (pointerType !== 'mouse') {
    if (!wasIdle) goIdle(true); // tap toggles the controls on touch screens
  } else if (role === 'host' && screenKind === 'file') {
    togglePlay();
  }
});

document.addEventListener('keydown', (e) => {
  if (room.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  wake();
  const target = e.target as HTMLElement;
  if (target.closest?.('input, textarea, select, dialog')) return;
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit && REACTIONS[+digit[1] - 1]) return react(REACTIONS[+digit[1] - 1], true);
  switch (e.code) {
    case 'Space':
      if (target.closest('button')) return;
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      seekBy(-10);
      break;
    case 'ArrowRight':
      seekBy(10);
      break;
    case 'KeyM':
      toggleMic();
      break;
    case 'KeyV':
      toggleCam();
      break;
    case 'KeyF':
      toggleFullscreen();
      break;
  }
});

// ---------------------------------------------------------------- wiring

btn.mic.addEventListener('click', toggleMic);
btn.cam.addEventListener('click', toggleCam);
btn.share.addEventListener('click', () => void toggleShare());
btn.file.addEventListener('click', () => fileInput.click());
btn.mode.addEventListener('click', toggleMode);
btn.pip.addEventListener('click', () => void togglePip());
btn.fit.addEventListener('click', () => main.classList.toggle('cover'));
btn.fs.addEventListener('click', toggleFullscreen);
btn.play.addEventListener('click', () => togglePlay());
$('fpBack').addEventListener('click', () => seekBy(-10));
$('fpFwd').addEventListener('click', () => seekBy(10));

btn.stats.addEventListener('click', () => {
  statsOn = !statsOn;
  $('stats').hidden = !statsOn;
  btn.stats.classList.toggle('active', statsOn);
  if (statsOn) stats.start();
  else stats.stop();
});
const stats = new StatsMonitor(
  () => link?.activePc() ?? null,
  (what) => what === 'screen' && role === 'host',
  (text) => ($('stats').textContent = text),
);

$('inviteBtn').addEventListener('click', () => {
  inviteForced = !!invite.hidden;
  inviteDismissed = !inviteForced;
  updateLayout();
});
$('inviteClose').addEventListener('click', () => {
  inviteForced = false;
  inviteDismissed = true;
  updateLayout();
});
$('copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteLink.value);
  } catch {
    inviteLink.select();
    document.execCommand('copy');
  }
  toast('Link copied — send it in your messenger');
});
const shareLinkBtn = $('shareLinkBtn');
shareLinkBtn.hidden = typeof navigator.share !== 'function';
shareLinkBtn.addEventListener('click', () => {
  navigator.share({ title: 'FilmWatcher for ViviShark', text: 'Let’s watch together 🍿', url: inviteLink.value }).catch(() => {});
});
inviteLink.addEventListener('focus', () => inviteLink.select());

$('pipYes').addEventListener('click', () => void togglePip());
$('pipNo').addEventListener('click', () => {
  pipPrompt.hidden = true;
  wake();
});

soundUnlock.addEventListener('click', () => {
  soundUnlock.hidden = true;
  for (const v of [main, partnerVideo, selfVideo]) if (v.srcObject || v.currentSrc) v.play().catch(() => {});
});

// settings
for (const [key, q] of Object.entries(QUALITY)) qualSel.add(new Option(q.label, key));
for (const [key, label] of Object.entries(ROUTE_CHOICES)) routeSel.add(new Option(label, key));
$('settingsBtn').addEventListener('click', () => {
  qualSel.value = quality;
  routeSel.value = routeChoice;
  selfChk.checked = selfView;
  partnerChk.checked = hidePartner;
  turnInput.value = store.get('turn');
  settingsDlg.showModal();
  void fillDevices();
});
routeSel.addEventListener('change', () => {
  routeChoice = routeSel.value as RouteChoice;
  store.set('route', routeChoice);
  if (!link) return;
  toast(`Reconnecting: ${ROUTE_CHOICES[routeChoice].split(' —')[0]}`);
  void connect();
});
$('testBtn').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('testBtn');
  const list = $('testResults');
  button.disabled = true;
  button.textContent = 'Testing…';
  list.replaceChildren();
  try {
    for (const { route, ok, total } of await checkRoutes()) {
      const li = document.createElement('li');
      li.className = ok ? 'ok' : 'bad';
      li.textContent = `${ok ? '✓' : '✗'} ${ROUTES[route].label}: ${
        total === 1 ? (ok ? 'reachable' : 'blocked') : `${ok} of ${total} servers reachable`
      }`;
      list.append(li);
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Test servers again';
  }
});
camSel.addEventListener('change', () => void switchDevice('video', camSel.value));
micSel.addEventListener('change', () => void switchDevice('audio', micSel.value));
qualSel.addEventListener('change', () => {
  quality = qualSel.value as QualityKey;
  store.set('quality', quality);
  link?.setQuality(quality);
});
selfChk.addEventListener('change', () => {
  selfView = selfChk.checked;
  store.set('selfView', selfView ? '1' : '0');
  updateLayout();
});
partnerChk.addEventListener('change', () => {
  hidePartner = partnerChk.checked;
  store.set('hidePartner', hidePartner ? '1' : '0');
  if (hidePartner) {
    pipPrompt.hidden = true;
    pipWin?.close();
    if (document.pictureInPictureElement === partnerVideo) {
      void document.exitPictureInPicture().catch(() => {});
    }
  }
  updateLayout();
});
settingsDlg.addEventListener('close', () => {
  const turn = turnInput.value.trim();
  if (turn !== store.get('turn')) {
    store.set('turn', turn);
    if (link) {
      toast('TURN saved — reconnecting');
      void connect();
    }
  }
  wake();
});
$('newRoomBtn').addEventListener('click', () => {
  if (!confirm('The old link will stop working. Make a new one?')) return;
  store.set('hostCode', newCode());
  link?.destroy();
  location.replace(location.pathname);
});

// keep the screen on and recover capture after the phone was locked / app switched
let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake(): Promise<void> {
  try {
    wakeLock = (await (navigator as unknown as { wakeLock?: { request(t: string): Promise<typeof wakeLock> } }).wakeLock?.request('screen')) ?? null;
  } catch {
    /* not allowed right now */
  }
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !media) return;
  if (!wakeLock || (wakeLock as { released?: boolean }).released) void keepAwake();
  const fresh = await media.revive();
  if (!fresh.length) return;
  fresh.forEach((t) => link?.replaceTrack(t));
  selfVideo.srcObject = media.stream;
  playSafe(selfVideo);
  renderMediaButtons();
  sendState();
});
window.addEventListener('pagehide', () => link?.destroy());
window.addEventListener('pageshow', (e) => e.persisted && link && location.reload());

paintIcons();
setupLobby();
renderFullscreen();
renderRemoteStatus();
