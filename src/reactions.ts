export const REACTIONS = ['😱', '🙈', '💀', '😂', '❤️', '🍿'];

/** Mine float up on the right half, the partner's on the left — so it's clear who reacted. */
export function spawnReaction(layer: HTMLElement, emoji: string, mine: boolean): void {
  const el = layer.ownerDocument.createElement('span');
  el.className = 'float';
  el.textContent = emoji;
  el.style.left = `${(mine ? 52 : 6) + Math.random() * 36}%`;
  el.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 140)}px`);
  el.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 50)}deg`);
  layer.append(el);
  const remove = () => el.remove();
  el.addEventListener('animationend', remove);
  setTimeout(remove, 4000);
}
