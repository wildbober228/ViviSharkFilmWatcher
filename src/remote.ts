export type RemoteCmd = 'toggle' | 'back' | 'fwd';
export type RemoteResult = { ok: boolean; playing?: boolean; error?: string };

/**
 * Talks to the "FilmWatcher Remote" Chrome extension (see /extension), which can pause and seek the
 * video in the tab being shared. The extension's bridge script answers on window.postMessage.
 */
export class RemoteControl {
  available = false;
  version = '';
  /** Last play state reported by the movie tab; null until it reports anything. */
  playing: boolean | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (r: RemoteResult) => void>();

  constructor(private readonly onChange: () => void) {
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const data = e.data as { fwr?: string; type?: string; id?: number; version?: string; playing?: boolean };
      if (data?.fwr !== 'ext') return;
      if (data.type === 'hello') {
        this.available = true;
        this.version = data.version ?? '';
        this.onChange();
      } else if (data.type === 'state') {
        this.playing = !!data.playing;
        this.onChange();
      } else if (data.type === 'result' && data.id) {
        this.pending.get(data.id)?.(data as RemoteResult);
        this.pending.delete(data.id);
      }
    });
    window.postMessage({ fwr: 'page', type: 'ping' }, location.origin);
  }

  send(cmd: RemoteCmd): Promise<RemoteResult> {
    if (!this.available) return Promise.resolve({ ok: false, error: 'not-installed' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, 4000);
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        if (result.playing !== undefined) this.playing = result.playing;
        resolve(result);
      });
      window.postMessage({ fwr: 'page', type: 'cmd', id, cmd }, location.origin);
    });
  }
}
