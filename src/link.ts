import { Peer, type DataConnection, type MediaConnection } from 'peerjs';
import { opusStereo, tuneSender, type QualityKey } from './media';

export type Role = 'host' | 'guest';
export type LinkStatus = 'server' | 'waiting' | 'connecting' | 'connected' | 'error';
export type ScreenKind = 'share' | 'file';

export type Msg =
  | { t: 'state'; cam: boolean; mic: boolean; screen: ScreenKind | false; playing?: boolean }
  | { t: 'react'; e: string }
  | { t: 'ctl'; a: 'toggle-play' | 'back' | 'fwd' }
  | { t: 'hello'; role: Role }
  | { t: 'bye' };

/** One way of getting host and guest connected; the app talks to whichever one won. */
export interface Link {
  readonly connected: boolean;
  start(): void;
  send(msg: Msg): void;
  /** Host: start, swap or stop what the guest sees. */
  setScreen(stream: MediaStream | null, sourceHeight?: number): void;
  setQuality(quality: QualityKey): void;
  /** Swap the camera or mic after a device change. */
  replaceTrack(track: MediaStreamTrack): void;
  /** For the stats readout. */
  activePc(): { pc: RTCPeerConnection; what: 'screen' | 'cam' } | null;
  destroy(): void;
}

export interface LinkEvents {
  status(status: LinkStatus, detail?: string): void;
  /** Partner camera + mic. */
  partner(stream: MediaStream | null): void;
  /** Guest only: the host's screen / movie. */
  screen(stream: MediaStream | null): void;
  message(msg: Msg): void;
}

export const hostPeerId = (code: string) => `filmwatcher-${code}-host`;

// Public STUN only: PeerJS's own TURN hosts no longer resolve. User-supplied TURN servers are appended.
export const DEFAULT_ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

/**
 * PeerJS route: one host, one guest, signalled through the PeerJS cloud server (behind Cloudflare).
 * Three channels between them:
 *  - data connection: state, reactions, playback control
 *  - "cam" call (guest → host): both cameras and mics
 *  - "screen" call (host → guest): the shared tab or local movie, one-way
 */
export class PeerJsLink implements Link {
  private peer?: Peer;
  private conn?: DataConnection;
  private pending?: DataConnection;
  private camCall?: MediaConnection;
  private screenCall?: MediaConnection;
  private screenStream: MediaStream | null = null;
  private screenHeight = 0;
  private quality: QualityKey = 'high';
  private timer = 0;
  private camTimer = 0;
  private openTimer = 0;
  private closed = false;
  private readonly gone = new WeakSet<object>();

  constructor(
    private readonly role: Role,
    private readonly code: string,
    private readonly local: () => MediaStream,
    private readonly ev: LinkEvents,
    private readonly extraIce: RTCIceServer[] = [],
  ) {}

  get connected(): boolean {
    return !!this.conn?.open;
  }

  start(): void {
    this.ev.status('server');
    if (this.role === 'host') this.startHost();
    else this.startGuest();
  }

  send(msg: Msg): void {
    if (this.conn?.open) this.conn.send(msg);
  }

  /** Host: start, swap or stop what the guest sees. */
  setScreen(stream: MediaStream | null, sourceHeight = 0): void {
    this.screenStream = stream;
    this.screenHeight = sourceHeight;
    if (stream) {
      this.callScreen();
    } else {
      const call = this.screenCall;
      this.screenCall = undefined;
      call?.close();
    }
  }

  setQuality(quality: QualityKey): void {
    this.quality = quality;
    if (this.screenCall) this.tune(this.screenCall, 'screen');
  }

  replaceTrack(track: MediaStreamTrack): void {
    const sender = this.camCall?.peerConnection?.getSenders().find((s) => s.track?.kind === track.kind);
    sender?.replaceTrack(track).catch((e) => console.warn('replaceTrack', e));
  }

  /** For the stats readout: the screen call if there is one, otherwise the camera call. */
  activePc(): { pc: RTCPeerConnection; what: 'screen' | 'cam' } | null {
    const screen = this.screenCall?.peerConnection;
    if (screen) return { pc: screen, what: 'screen' };
    const cam = this.camCall?.peerConnection;
    return cam ? { pc: cam, what: 'cam' } : null;
  }

  destroy(): void {
    if (this.closed) return;
    this.send({ t: 'bye' });
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.camTimer);
    clearTimeout(this.openTimer);
    this.peer?.destroy();
  }

  // ---------------------------------------------------------------- setup

  private newPeer(id?: string): Peer {
    const options = { config: { iceServers: [...DEFAULT_ICE, ...this.extraIce] }, debug: 1 };
    const peer = id ? new Peer(id, options) : new Peer(options);
    peer.on('disconnected', () => {
      // Signalling server dropped us; P2P links keep working, but we need it for reconnects.
      const retry = () => {
        if (this.closed || peer.destroyed || !peer.disconnected) return;
        peer.reconnect();
        window.setTimeout(retry, 5000);
      };
      window.setTimeout(retry, 1500);
    });
    return peer;
  }

  private later(fn: () => void, ms: number): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      if (!this.closed) fn();
    }, ms);
  }

  private onPeerError(err: { type: string; message?: string }): void {
    console.warn('peer error', err.type, err.message);
    if (this.closed) return;
    if (this.peer?.destroyed) {
      this.ev.status('server', 'Lost the server — reconnecting…');
      this.later(() => this.start(), 4000);
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      if (!this.connected) this.ev.status('server', 'Lost the server — reconnecting…');
    }
  }

  // ---------------------------------------------------------------- host

  private startHost(attempt = 0): void {
    const peer = this.newPeer(hostPeerId(this.code));
    this.peer = peer;
    peer.on('open', () => {
      if (!this.connected) this.ev.status('waiting');
    });
    peer.on('connection', (conn) => this.adopt(conn));
    peer.on('call', (call) => {
      if (call.metadata?.kind !== 'cam') return call.close();
      const old = this.camCall;
      this.camCall = call;
      old?.close();
      call.answer(this.local());
      this.watchCam(call);
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        peer.destroy();
        this.ev.status(
          'server',
          attempt > 2 ? 'Is the room already open in another tab? Waiting for it to free up…' : 'Freeing up the room…',
        );
        this.later(() => this.startHost(attempt + 1), 3000);
      } else {
        this.onPeerError(err);
      }
    });
  }

  private adopt(conn: DataConnection): void {
    conn.on('open', () => {
      // The newest guest wins: that's the same person after a reload or network switch.
      const old = this.conn;
      this.conn = conn;
      if (old && old !== conn) this.dropConn(old);
      this.ev.status('connected');
      if (this.screenStream) this.callScreen();
    });
    this.wireConn(conn);
  }

  private callScreen(): void {
    if (!this.peer || !this.conn?.open || !this.screenStream) return;
    const old = this.screenCall;
    this.screenCall = undefined;
    old?.close();
    const call = this.peer.call(this.conn.peer, this.screenStream, {
      metadata: { kind: 'screen' },
      sdpTransform: opusStereo,
    });
    this.screenCall = call;
    call.on('close', () => {
      if (this.screenCall !== call) return;
      this.screenCall = undefined;
      // Dropped by the network rather than by us: try again while the share is still on.
      if (this.screenStream && this.conn?.open) window.setTimeout(() => this.screenCall || this.callScreen(), 2000);
    });
    this.watchPc(call, 'screen');
  }

  // ---------------------------------------------------------------- guest

  private startGuest(): void {
    const peer = this.newPeer();
    this.peer = peer;
    peer.on('open', () => this.dial());
    peer.on('call', (call) => {
      if (call.metadata?.kind !== 'screen') return call.close();
      const old = this.screenCall;
      this.screenCall = call;
      old?.close();
      call.answer(undefined, { sdpTransform: opusStereo });
      call.on('stream', (s) => {
        if (this.screenCall === call) this.ev.screen(s);
      });
      call.on('close', () => {
        if (this.screenCall !== call) return;
        this.screenCall = undefined;
        this.ev.screen(null);
      });
      this.watchPc(call, 'screen');
    });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        if (!this.connected) this.ev.status('waiting');
        this.later(() => this.dial(), 3000);
      } else {
        this.onPeerError(err);
      }
    });
  }

  private dial(): void {
    const peer = this.peer;
    if (this.closed || !peer || peer.destroyed || this.connected) return;
    if (peer.disconnected) return this.later(() => this.dial(), 2000);

    if (this.pending && !this.pending.open) this.dropConn(this.pending);
    this.ev.status('connecting');
    const conn = peer.connect(hostPeerId(this.code), { reliable: true, serialization: 'json' });
    this.pending = conn;

    clearTimeout(this.openTimer);
    this.openTimer = window.setTimeout(() => {
      if (conn.open || this.pending !== conn) return;
      this.dropConn(conn);
      this.ev.status('error', 'Can’t get through — the network is blocking us. Trying again…');
      this.later(() => this.dial(), 3000);
    }, 20_000);

    conn.on('open', () => {
      clearTimeout(this.openTimer);
      this.pending = undefined;
      this.conn = conn;
      this.ev.status('connected');
      this.callCam();
    });
    this.wireConn(conn);
  }

  private callCam(): void {
    if (!this.peer || !this.conn?.open) return;
    const old = this.camCall;
    this.camCall = undefined;
    old?.close();
    const call = this.peer.call(hostPeerId(this.code), this.local(), { metadata: { kind: 'cam' } });
    this.camCall = call;
    this.watchCam(call);
  }

  // ---------------------------------------------------------------- shared plumbing

  private wireConn(conn: DataConnection): void {
    conn.on('data', (data) => {
      const msg = data as Msg;
      if (msg?.t === 'bye') this.dropConn(conn);
      else if (msg?.t) this.ev.message(msg);
    });
    conn.on('close', () => this.dropConn(conn));
    conn.on('error', () => this.dropConn(conn));
  }

  private dropConn(conn: DataConnection): void {
    if (this.gone.has(conn)) return;
    this.gone.add(conn);
    conn.close();
    if (this.pending === conn) this.pending = undefined;
    if (this.conn !== conn) return;

    this.conn = undefined;
    for (const call of [this.camCall, this.screenCall]) call?.close();
    this.camCall = this.screenCall = undefined;
    this.ev.partner(null);
    if (this.role === 'guest') this.ev.screen(null);
    if (this.closed) return;
    this.ev.status('waiting');
    if (this.role === 'guest') this.later(() => this.dial(), 2000);
  }

  private watchCam(call: MediaConnection): void {
    call.on('stream', (s) => {
      if (this.camCall === call) this.ev.partner(s);
    });
    call.on('close', () => {
      if (this.camCall !== call) return;
      this.camCall = undefined;
      this.ev.partner(null);
      // Camera link died but we're still talking: the guest redials it.
      if (this.role === 'guest' && this.conn?.open) {
        clearTimeout(this.camTimer);
        this.camTimer = window.setTimeout(() => this.camCall || this.callCam(), 2000);
      }
    });
    this.watchPc(call, 'cam');
  }

  private watchPc(call: MediaConnection, kind: 'cam' | 'screen'): void {
    const pc = call.peerConnection;
    if (!pc) return;
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') this.tune(call, kind);
      if (pc.connectionState === 'failed') {
        console.warn(kind, 'call failed');
        call.close();
      }
    });
  }

  private tune(call: MediaConnection, kind: 'cam' | 'screen'): void {
    for (const sender of call.peerConnection?.getSenders() ?? []) {
      tuneSender(sender, kind, this.quality, this.screenHeight);
    }
  }
}
