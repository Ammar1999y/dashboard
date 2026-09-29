const BYTE_UNITS = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number, decimals = 2): string {
  if (!(bytes > 0)) return '0 Bytes';

  const i = Math.min(
    Math.max(Math.floor(Math.log(bytes) / Math.log(1024)), 0),
    BYTE_UNITS.length - 1
  );
  return `${Number((bytes / 1024 ** i).toFixed(decimals))} ${BYTE_UNITS[i]}`;
}
