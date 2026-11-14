import { PeerJsLink, type Link, type LinkEvents, type LinkStatus, type Msg, type Role } from './link';
import type { QualityKey } from './media';
import type { Route } from './routes';
import { TrysteroLink } from './trystero-link';

const PRIORITY: LinkStatus[] = ['connected', 'connecting', 'waiting', 'server', 'error'];

/**
 * Runs several routes side by side and lets the app talk to whichever one connects first.
 * The guest drops the losing routes as soon as one wins; the host keeps listening on all of them,
 * so a guest can come back through any route that works for them.
 */
export class Switchboard implements Link {
  private readonly links = new Map<Route, Link>();
  private readonly statuses = new Map<Route, [LinkStatus, string | undefined]>();
  // What each route has received, replayed when it becomes the active one.
  private readonly partnerStreams = new Map<Route, MediaStream | null>();
  private readonly screenStreams = new Map<Route, MediaStream | null>();
  private readonly states = new Map<Route, Msg>();
  private active: Route | null = null;
  private shown = '';
  private screen: { stream: MediaStream | null; height: number } = { stream: null, height: 0 };
  private quality: QualityKey = 'high';
  private respawnTimer = 0;
  private closed = false;

  constructor(
    private readonly role: Role,
    private readonly code: string,
    private readonly local: () => MediaStream,
    private readonly ev: LinkEvents,
    private readonly extraIce: RTCIceServer[],
    private readonly routes: Route[],
  ) {}

  get connected(): boolean {
    return !!this.active && !!this.links.get(this.active)?.connected;
  }

  /** The route currently carrying the call, for the status line. */
  get activeRoute(): Route | null {
    return this.connected ? this.active : null;
  }

  start(): void {
    for (const route of this.routes) this.spawn(route);
    this.report();
  }

  send(msg: Msg): void {
    if (this.active) this.links.get(this.active)?.send(msg);
  }

  setScreen(stream: MediaStream | null, sourceHeight = 0): void {
    this.screen = { stream, height: sourceHeight };
    if (this.active) this.links.get(this.active)?.setScreen(stream, sourceHeight);
  }

  setQuality(quality: QualityKey): void {
    this.quality = quality;
    for (const link of this.links.values()) link.setQuality(quality);
  }

  replaceTrack(track: MediaStreamTrack): void {
    for (const link of this.links.values()) link.replaceTrack(track);
  }

  activePc(): { pc: RTCPeerConnection; what: 'screen' | 'cam' } | null {
    return this.active ? (this.links.get(this.active)?.activePc() ?? null) : null;
  }

  destroy(): void {
    this.closed = true;
    clearTimeout(this.respawnTimer);
    for (const link of this.links.values()) link.destroy();
    this.links.clear();
  }

  // ----------------------------------------------------------------

  private spawn(route: Route): void {
    if (this.closed || this.links.has(route)) return;
    const events: LinkEvents = {
      status: (s, detail) => this.onStatus(route, s, detail),
      partner: (stream) => {
        this.partnerStreams.set(route, stream);
        if (this.active === route) this.ev.partner(stream);
      },
      screen: (stream) => {
        this.screenStreams.set(route, stream);
        if (this.active === route) this.ev.screen(stream);
      },
      message: (msg) => {
        if (msg.t === 'state') this.states.set(route, msg);
        if (this.active === route) this.ev.message(msg);
      },
    };
    const link =
      route === 'peerjs'
        ? new PeerJsLink(this.role, this.code, this.local, events, this.extraIce)
        : new TrysteroLink(route, this.role, this.code, this.local, events, this.extraIce);
    link.setQuality(this.quality);
    this.links.set(route, link);
    link.start();
  }

  private onStatus(route: Route, status: LinkStatus, detail?: string): void {
    if (this.closed || !this.links.has(route)) return;
    this.statuses.set(route, [status, detail]);

    if (status === 'connected') {
      // Same route, new partner (e.g. the guest reloaded): pass it on so the app re-sends its state.
      if (route === this.active) this.ev.status('connected');
      // A second path to someone while one is already live just stays idle.
      else if (!this.connected) this.activate(route);
      return;
    }
    if (route === this.active) {
      this.active = null;
      this.ev.partner(null);
      if (this.role === 'guest') this.ev.screen(null);
      const next = [...this.links].find(([, link]) => link.connected);
      if (next) return this.activate(next[0]);
      if (this.role === 'guest') {
        // Bring the other routes back and race again.
        clearTimeout(this.respawnTimer);
        this.respawnTimer = window.setTimeout(() => this.routes.forEach((r) => this.spawn(r)), 1500);
      }
    }
    if (!this.connected) this.report();
  }

  private activate(route: Route): void {
    const previous = this.active;
    this.active = route;
    const link = this.links.get(route)!;
    if (this.role === 'host') {
      if (previous && previous !== route) this.links.get(previous)?.setScreen(null);
      link.setScreen(this.screen.stream, this.screen.height);
    }
    this.shown = 'connected';
    this.ev.status('connected');
    this.ev.partner(this.partnerStreams.get(route) ?? null);
    if (this.role === 'guest') this.ev.screen(this.screenStreams.get(route) ?? null);
    const state = this.states.get(route);
    if (state) this.ev.message(state);

    if (this.role === 'guest') {
      for (const [other, otherLink] of this.links) {
        if (other === route) continue;
        otherLink.destroy();
        this.links.delete(other);
        this.statuses.delete(other);
      }
    }
  }

  /** While nothing is connected, show the most hopeful status any route has. */
  private report(): void {
    let best: [LinkStatus, string | undefined] | undefined;
    for (const value of this.statuses.values()) {
      if (!best || PRIORITY.indexOf(value[0]) < PRIORITY.indexOf(best[0])) best = value;
    }
    const [status, detail] = best ?? ['server', undefined];
    // A route's own trouble ("lost the server") only matters when no other route is doing better.
    const shownDetail = status === 'server' || status === 'error' ? detail : undefined;
    const key = `${status}|${shownDetail ?? ''}`;
    if (key === this.shown) return;
    this.shown = key;
    this.ev.status(status, shownDetail);
  }
}
