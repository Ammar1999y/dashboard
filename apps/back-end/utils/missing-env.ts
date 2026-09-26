export function missingServerEnvMessage(names: readonly string[]): string {
  return `Missing required server env var${names.length > 1 ? 's' : ''}: ${names.join(', ')}`;
}
