// localStorage can throw (private mode, blocked storage) — everything here degrades to defaults.
export const store = {
  get(key: string, fallback = ''): string {
    try {
      return localStorage.getItem('fw.' + key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem('fw.' + key, value);
    } catch {
      /* ignore */
    }
  },
};

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function newCode(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Accepts a bare code or a whole invite link pasted by hand. */
export function parseCode(input: string): string {
  let s = input.trim();
  const fromLink = s.match(/[?&]r=([a-z0-9]+)/i);
  if (fromLink) s = fromLink[1];
  s = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return s.length >= 4 && s.length <= 32 ? s : '';
}
