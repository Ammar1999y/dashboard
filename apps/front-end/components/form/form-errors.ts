import { toast } from 'sonner';
import { MSG_INVALID_INPUT } from '@app/shared/messages/common';

const TOASTED_MESSAGES_MAX = 3;

export function showFormErrors(messages: Record<string, string>) {
  const shown = Object.values(messages)
    .filter((message) => message.trim() !== '')
    .slice(0, TOASTED_MESSAGES_MAX);

  toast.error(shown.length > 0 ? shown.join('\n') : MSG_INVALID_INPUT);
}

export function flattenErrors(data: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  collectErrors(data, '', result);
  return result;
}

function collectErrors(
  data: unknown,
  path: string,
  result: Record<string, string>
): void {
  if (Array.isArray(data)) {
    data.forEach((item, index) => {
      collectErrors(item, path ? `${path}.${index}` : String(index), result);
    });
    return;
  }
  if (!data || typeof data !== 'object') return;

  if ('message' in data && typeof data.message === 'string') {
    result[path] = data.message;
    return;
  }
  for (const [key, value] of Object.entries(data)) {
    // A field error's `ref` is the DOM node — walking it reaches React's fiber.
    if (key === 'ref') continue;
    collectErrors(value, path ? `${path}.${key}` : key, result);
  }
}
