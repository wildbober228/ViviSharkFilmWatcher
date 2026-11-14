import type { Room } from '@trystero-p2p/nostr';
import { DEFAULT_ICE, type Link, type LinkEvents, type Msg, type Role } from './link';
import { opusStereo, tuneSender, type QualityKey } from './media';
import { RELAYS, type Route } from './routes';

type RelayRoute = Exclude<Route, 'peerjs'>;

type Strategy = {
  joinRoom: (config: Record<string, unknown>, roomId: string) => Room;
  getRelaySockets: () => Record<string, WebSocket>;
};

// Loaded on demand so people who never need them don't download them.
const STRATEGIES: Record<RelayRoute, () => Promise<Strategy>> = {
  nostr: () => import('@trystero-p2p/nostr') as unknown as Promise<Strategy>,
  mqtt: () => import('@trystero-p2p/mqtt') as unknown as Promise<Strategy>,
};

const APP_ID = 'filmwatcher-vivishark';

let StereoPeerConnection: typeof RTCPeerConnection | undefined;

/**
 * Trystero creates the peer connections itself, so stereo Opus is requested by rewriting the
 * other side's description: "stereo=1" there tells our encoder to send stereo to them.
 */
function stereoPeerConnection(): typeof RTCPeerConnection {
  if (StereoPeerConnection) return StereoPeerConnection;
  type SetRemote = (this: RTCPeerConnection, desc?: RTCSessionDescriptionInit) => Promise<void>;
  const base = RTCPeerConnection.prototype.setRemoteDescription as SetRemote;
  class Stereo extends RTCPeerConnection {}
  Stereo.prototype.setRemoteDescription = function (this: RTCPeerConnection, desc?: RTCSessionDescriptionInit) {
    return base.call(this, desc?.sdp ? { type: desc.type, sdp: opusStereo(desc.sdp) } : desc);
  } as SetRemote as typeof RTCPeerConnection.prototype.setRemoteDescription;
  return (StereoPeerConnection = Stereo);
}

/**
 * Nostr / MQTT route: both sides join a room on public relays (no Cloudflare) and Trystero
 * negotiates one peer connection carrying both cameras, the movie and the data channel.
 * Rooms are symmetric, so peers say hello with their role and only a host and a guest pair up.
 */
export class TrysteroLink implements Link {
  private room?: Room;
  private sendMsg: (msg: Msg, target: string) => void = () => {};
  private partner: string | null = null;
  private screenStream: MediaStream | null = null;
  private screenHeight = 0;
  private gotScreen = false;
  private quality: QualityKey = 'high';
  private readonly camTracks = new Map<string, MediaStreamTrack>();
  private poll = 0;
  private closed = false;

  constructor(
    private readonly route: RelayRoute,
    private readonly role: Role,
    private readonly code: string,
    private readonly local: () => MediaStream,
    private readonly ev: LinkEvents,
    private readonly extraIce: RTCIceServer[] = [],
  ) {}

  get connected(): boolean {
    return this.partner !== null;
  }

  start(): void {
    this.ev.status('server');
    STRATEGIES[this.route]()
      .then((strategy) => this.closed || this.join(strategy))
      .catch((e) => this.ev.status('error', `Couldn’t load the ${this.route} connection: ${e?.message ?? e}`));
  }

  send(msg: Msg): void {
    if (this.partner) this.sendMsg(msg, this.partner);
  }

  setScreen(stream: MediaStream | null, sourceHeight = 0): void {
    const old = this.screenStream;
    this.screenStream = stream;
    this.screenHeight = sourceHeight;
    if (!this.room || !this.partner || old === stream) return;
    if (old) this.room.removeStream(old, { target: this.partner });
    if (stream) this.addStream(stream, 'screen');
  }

  setQuality(quality: QualityKey): void {
    this.quality = quality;
    this.tune();
  }

  replaceTrack(track: MediaStreamTrack): void {
    const old = this.camTracks.get(track.kind);
    this.camTracks.set(track.kind, track);
    if (old && old !== track && this.room && this.partner) {
      this.room.replaceTrack(old, track, { target: this.partner }).catch((e) => console.warn('replaceTrack', e));
    }
  }

  activePc(): { pc: RTCPeerConnection; what: 'screen' | 'cam' } | null {
    const pc = this.pc();
    if (!pc) return null;
    const screen = this.role === 'host' ? !!this.screenStream : this.gotScreen;
    return { pc, what: screen ? 'screen' : 'cam' };
  }

  destroy(): void {
    if (this.closed) return;
    this.send({ t: 'bye' });
    this.closed = true;
    clearInterval(this.poll);
    this.room?.leave().catch(() => {});
  }

  // ----------------------------------------------------------------

  private join(strategy: Strategy): void {
    const relays = RELAYS[this.route];
    const room = strategy.joinRoom(
      {
        appId: APP_ID,
        password: this.code, // encrypts the offers the relays carry
        identity: 'none',
        rtcConfig: { iceServers: [...DEFAULT_ICE, ...this.extraIce] },
        rtcPolyfill: stereoPeerConnection(),
        relayConfig: { urls: relays, redundancy: relays.length, warnOnRelayFailure: false },
      },
      `room-${this.code}`,
    );
    this.room = room;

    const action = room.makeAction<Msg>('msg');
    this.sendMsg = (msg, target) => void action.send(msg, { target }).catch(() => {});
    action.onMessage((msg, { peerId }) => this.onMessage(msg, peerId));
    room.onPeerJoin(({ peerId }) => this.sendMsg({ t: 'hello', role: this.role }, peerId));
    room.onPeerLeave(({ peerId }) => peerId === this.partner && this.drop());
    room.onPeerStream((stream, { peerId, metadata }) => {
      if (peerId !== this.partner) return;
      if ((metadata as { kind?: string } | undefined)?.kind === 'screen') {
        this.gotScreen = true;
        this.ev.screen(stream);
      } else {
        this.ev.partner(stream);
      }
    });
    room.onError((e) => console.warn(`[${this.route}]`, e.code, e.message));

    // Until someone shows up, report whether any relay is reachable at all.
    const relayStatus = () => {
      if (this.closed || this.partner) return;
      const open = Object.values(strategy.getRelaySockets()).some((ws) => ws?.readyState === WebSocket.OPEN);
      this.ev.status(open ? 'waiting' : 'server');
    };
    this.poll = window.setInterval(relayStatus, 2000);
  }

  private onMessage(msg: Msg, peerId: string): void {
    if (msg?.t === 'hello') {
      // Two guests (or two hosts) can meet in a symmetric room — they're not each other's partner.
      if (msg.role !== this.role && peerId !== this.partner) this.adopt(peerId);
      return;
    }
    if (peerId !== this.partner) return;
    if (msg.t === 'bye') return this.drop();
    if (msg.t === 'state') this.gotScreen = !!msg.screen && this.gotScreen;
    this.ev.message(msg);
  }

  private adopt(peerId: string): void {
    const room = this.room!;
    const previous = this.partner;
    this.partner = peerId; // the newest one wins: same person after a reload
    if (previous) {
      room.removeStream(this.local(), { target: previous });
      if (this.screenStream) room.removeStream(this.screenStream, { target: previous });
    }
    for (const track of this.local().getTracks()) this.camTracks.set(track.kind, track);
    this.addStream(this.local(), 'cam');
    if (this.role === 'host' && this.screenStream) this.addStream(this.screenStream, 'screen');

    // Re-apply bitrate caps whenever a (re)negotiation settles.
    const pc = this.pc();
    pc?.addEventListener('signalingstatechange', () => pc.signalingState === 'stable' && this.tune());
    pc?.addEventListener('connectionstatechange', () => pc.connectionState === 'connected' && this.tune());
    this.ev.status('connected');
  }

  private addStream(stream: MediaStream, kind: 'cam' | 'screen'): void {
    this.room
      ?.addStream(stream, { target: this.partner, metadata: { kind } })
      .then(() => this.tune())
      .catch((e) => console.warn(`[${this.route}] addStream`, e));
  }

  private drop(): void {
    if (!this.partner) return;
    this.partner = null;
    this.gotScreen = false;
    this.ev.partner(null);
    if (this.role === 'guest') this.ev.screen(null);
    if (!this.closed) this.ev.status('waiting');
  }

  private pc(): RTCPeerConnection | null {
    return (this.partner && this.room?.getPeers()[this.partner]?.connection) || null;
  }

  private tune(): void {
    const pc = this.pc();
    if (!pc) return;
    const screenTracks = new Set(this.screenStream?.getTracks() ?? []);
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const kind = screenTracks.has(sender.track) ? 'screen' : 'cam';
      tuneSender(sender, kind, this.quality, this.screenHeight);
    }
  }
}
