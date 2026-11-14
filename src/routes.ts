export type Route = 'peerjs' | 'nostr' | 'mqtt';
export type RouteChoice = Route | 'auto';

export const ROUTES: Record<Route, { label: string }> = {
  peerjs: { label: 'PeerJS' },
  nostr: { label: 'Nostr' },
  mqtt: { label: 'MQTT' },
};

export const ROUTE_CHOICES: Record<RouteChoice, string> = {
  auto: 'Auto — try every server at once (recommended)',
  peerjs: 'PeerJS only — fastest; behind Cloudflare, needs a VPN in Russia',
  nostr: 'Nostr relays only — no Cloudflare',
  mqtt: 'MQTT brokers only — no Cloudflare',
};

export const routesFor = (choice: RouteChoice): Route[] => (choice === 'auto' ? ['peerjs', 'nostr', 'mqtt'] : [choice]);

const PEERJS_SERVER = 'wss://0.peerjs.com/peerjs';

/**
 * Public relays that are not behind Cloudflare (checked by IP). Both sides use the same list,
 * so they meet on whichever relays each of them can reach.
 */
export const RELAYS: Record<Exclude<Route, 'peerjs'>, string[]> = {
  nostr: [
    'wss://relay.snort.social',
    'wss://nostr-pub.wellorder.net',
    'wss://nostr.data.haus',
    'wss://relay.mostro.network',
    'wss://nostr.azzamo.net',
    'wss://relay.angor.io',
    'wss://yabu.me',
    'wss://relay.nostrhub.fr',
    'wss://nostr-01.yakihonne.com',
    'wss://relay.wavlake.com',
    'wss://relay.guggero.org',
    'wss://nostr.sathoarder.com',
  ],
  mqtt: [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://public:public@public.cloud.shiftr.io',
  ],
};

export type RouteCheck = { route: Route; ok: number; total: number };

/** Can this device open a socket to each server? Used by the "Test servers" button. */
export async function checkRoutes(timeoutMs = 7000): Promise<RouteCheck[]> {
  const id = Math.random().toString(36).slice(2);
  const targets: Array<[Route, string, string[] | undefined, ((data: string) => boolean)?]> = [
    // PeerJS only counts once the server has actually answered with OPEN.
    [
      'peerjs',
      `${PEERJS_SERVER}?key=peerjs&id=fw-check-${id}&token=${id}`,
      undefined,
      (data) => data.includes('"OPEN"'),
    ],
    ...RELAYS.nostr.map((url): [Route, string, undefined] => ['nostr', url, undefined]),
    ...RELAYS.mqtt.map((url): [Route, string, string[]] => ['mqtt', url.replace(/\/\/[^@/]+@/, '//'), ['mqtt']]),
  ];
  const results = await Promise.all(targets.map(([, url, protocols, accept]) => probe(url, protocols, accept, timeoutMs)));
  return (['peerjs', 'nostr', 'mqtt'] as Route[]).map((route) => {
    const mine = results.filter((_, i) => targets[i][0] === route);
    return { route, ok: mine.filter(Boolean).length, total: mine.length };
  });
}

function probe(
  url: string,
  protocols: string[] | undefined,
  accept: ((data: string) => boolean) | undefined,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    const done = (ok: boolean) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      ws = new WebSocket(url, protocols);
    } catch {
      return done(false);
    }
    ws.onopen = () => !accept && done(true);
    ws.onmessage = (e) => accept && done(accept(String(e.data)));
    ws.onerror = () => done(false);
  });
}
