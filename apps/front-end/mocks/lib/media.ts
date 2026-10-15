import type { FileTransition } from '@app/shared/validation/enums';

const WIDTH = 160;
const HEIGHT = 120;

/**
 * A small image to stand for a stored one: a coloured card with `label`. Kept
 * to a few hundred bytes because every row is saved in `localStorage`.
 */
export function placeholderImage(label: string, hue: number): string {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="hsl(${hue} 55% 82%)"/>`,
    `<text x="50%" y="54%" text-anchor="middle" font-family="sans-serif" font-size="22" fill="hsl(${hue} 45% 28%)">${label}</text>`,
    '</svg>',
  ].join('');
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * How long a visibility change in flight stays, and how long the stale copy it
 * leaves: the server's nightly sweep settles both, which a session would never
 * wait for, so the mock settles them within minutes.
 */
const IN_FLIGHT_SETTLE_MS = 10 * 60_000;
const CLEANUP_SETTLE_MS = 90_000;

/** When a visibility change begun now stops holding the file. */
export const settlesAt = (transition: FileTransition) =>
  new Date(
    Date.now() +
      (transition === 'cleanup' ? CLEANUP_SETTLE_MS : IN_FLIGHT_SETTLE_MS)
  ).toISOString();
