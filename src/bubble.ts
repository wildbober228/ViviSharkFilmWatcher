import { store } from './store';

const LEVELS = [0.13, 0.2, 0.3];
const SIDE = 14;

type Place = { x: number; y: number; level: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep clear of the status bar and the controls (smaller gaps on a landscape phone). */
const gaps = (stageHeight: number) => (stageHeight < 520 ? { top: 50, bottom: 66 } : { top: 62, bottom: 86 });

/**
 * A floating camera window: drag anywhere, double-tap to cycle the size.
 * Position is stored as a 0..1 fraction of the free space, so it survives rotation and resizes.
 */
export class Bubble {
  private place: Place;
  private aspect = 4 / 3;
  private drag: { px: number; py: number; x: number; y: number; moved: boolean } | null = null;
  private lastTap = 0;
  private w = 0;
  private h = 0;

  constructor(
    readonly el: HTMLElement,
    private readonly stage: HTMLElement,
    private readonly key: string,
    defaults: Place,
  ) {
    let saved: Partial<Place> = {};
    try {
      saved = JSON.parse(store.get('bubble.' + key, '{}'));
    } catch {
      /* ignore */
    }
    this.place = { ...defaults, ...saved };
    this.place.level = clamp(Math.round(this.place.level), 0, LEVELS.length - 1);

    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', () => this.end());
    new ResizeObserver(() => this.layout()).observe(stage);
  }

  setAspect(ratio: number): void {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    this.aspect = clamp(ratio, 0.5, 2.4);
    this.el.style.setProperty('--aspect', String(this.aspect));
    this.layout();
  }

  layout(): void {
    if (this.el.classList.contains('fill') || this.el.hidden) return;
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    if (!W || !H) return;
    const { top, bottom } = gaps(H);
    let w = clamp(Math.max(W, H) * LEVELS[this.place.level], 92, 560);
    let h = w / this.aspect;
    const maxH = (H - top - bottom) * 0.6;
    if (h > maxH) {
      h = maxH;
      w = h * this.aspect;
    }
    this.w = w;
    this.h = h;
    const left = SIDE + this.place.x * Math.max(0, W - w - 2 * SIDE);
    const y = top + this.place.y * Math.max(0, H - h - top - bottom);
    Object.assign(this.el.style, {
      width: `${w}px`,
      height: `${h}px`,
      transform: `translate(${left}px, ${y}px)`,
    });
  }

  private down(e: PointerEvent): void {
    if (this.el.classList.contains('fill') || e.button > 0) return;
    e.stopPropagation();
    this.el.setPointerCapture(e.pointerId);
    this.drag = { px: e.clientX, py: e.clientY, x: this.place.x, y: this.place.y, moved: false };
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true;
    this.el.classList.add('dragging');
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const { top, bottom } = gaps(H);
    const freeX = Math.max(1, W - this.w - 2 * SIDE);
    const freeY = Math.max(1, H - this.h - top - bottom);
    this.place.x = clamp(d.x + dx / freeX, 0, 1);
    this.place.y = clamp(d.y + dy / freeY, 0, 1);
    this.layout();
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    e.stopPropagation();
    if (!d.moved) {
      const now = performance.now();
      if (now - this.lastTap < 330) {
        this.place.level = (this.place.level + 1) % LEVELS.length;
        this.lastTap = 0;
        this.layout();
      } else {
        this.lastTap = now;
      }
    }
    this.end();
  }

  private end(): void {
    this.drag = null;
    this.el.classList.remove('dragging');
    store.set('bubble.' + this.key, JSON.stringify(this.place));
  }
}
