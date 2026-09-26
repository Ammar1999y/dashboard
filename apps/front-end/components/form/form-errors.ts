import { toast } from 'sonner';

const TOASTED_MESSAGES_MAX = 3;

export function showFormErrors(messages: Record<string, string>) {
  const shown = Object.values(messages)
    .filter((message) => message.trim() !== '')
    .slice(0, TOASTED_MESSAGES_MAX);

  toast.error(shown.length > 0 ? shown.join('\n') : 'تحقق من صحة جميع الخانات');
}

export function flattenErrors(
  data: unknown,
  path = '',
  result: Record<string, string> = {}
): Record<string, string> {
  if (Array.isArray(data)) {
    data.forEach((item, index) => {
      flattenErrors(item, path ? `${path}.${index}` : String(index), result);
    });
    return result;
  }
  if (!data || typeof data !== 'object') return result;

  if ('message' in data && typeof data.message === 'string') {
    result[path] = data.message;
    return result;
  }
  for (const [key, value] of Object.entries(data)) {
    // A field error's `ref` is the DOM node — walking it reaches React's fiber.
    if (key === 'ref') continue;
    flattenErrors(value, path ? `${path}.${key}` : key, result);
  }
  return result;
}
