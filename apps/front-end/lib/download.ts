function clickLink(link: HTMLAnchorElement) {
  document.body.append(link);
  link.click();
  link.remove();
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  clickLink(link);
  URL.revokeObjectURL(url);
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
