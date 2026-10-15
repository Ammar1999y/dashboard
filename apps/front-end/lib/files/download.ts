/**
 * How long an object URL outlives the click or window that reads it. No event
 * says a download or a new tab is done with it, and revoking first can cancel
 * the one and blank the other.
 */
const OBJECT_URL_LIFETIME_MS = 60_000;

function withObjectUrl<T>(blob: Blob, read: (url: string) => T): T {
  const url = URL.createObjectURL(blob);
  try {
    return read(url);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
  }
}

function clickLink(link: HTMLAnchorElement) {
  document.body.append(link);
  link.click();
  link.remove();
}

export function downloadBlob(blob: Blob, filename: string) {
  withObjectUrl(blob, (url) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    clickLink(link);
  });
}

/** The opened window, or `null` when it was blocked or `features` holds `noopener`. */
export function openBlob(blob: Blob, features?: string): Window | null {
  return withObjectUrl(blob, (url) => window.open(url, '_blank', features));
}

/** Cross-origin URLs ignore `download` and navigate: a new tab keeps this one. */
export function downloadUrl(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.target = '_blank';
  link.rel = 'noopener';
  clickLink(link);
}

/**
 * `downloadUrl` without a new tab, for a link the server serves as an
 * attachment: several can start from one click, and none waits on a popup
 * blocker after an awaited request.
 */
export function downloadInFrame(url: string) {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = url;
  document.body.append(frame);
  setTimeout(() => frame.remove(), OBJECT_URL_LIFETIME_MS);
}
