import type { UploaderId } from './lab-store';
import type { FileErrorReason } from '@/lib/files/prepare';

import { toast } from 'sonner';
import { closeAllDialogs } from '@/lib/dialogs';
import { FileError, prepareFile } from '@/lib/files/prepare';

import { remountUploaders, useLab } from './lab-store';
import { sampleImage } from './samples';

export type Check = (check: string, ok: boolean, detail?: string) => void;

export interface Scenario {
  group: string;
  title: string;
  run: (check: Check) => Promise<void>;
}

export const POLL_MS = 50;
export const SETTLE_MS = 300;
export const PREPARE_TIMEOUT_MS = 20_000;

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(
  predicate: () => boolean,
  timeout = PREPARE_TIMEOUT_MS
) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeout) return false;
    await wait(POLL_MS);
  }
  return true;
}

/** What `promise` settled to: the value, or the error it rejected with. */
export async function settle<T>(promise: Promise<T>): Promise<T | Error> {
  try {
    return await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export const describe = (value: unknown) =>
  value instanceof FileError
    ? `${value.reason}: ${value.message}`
    : value instanceof File
      ? `${value.type} ${value.size}B ${value.name}`
      : String(value);

export function expectRefusal(
  check: Check,
  value: unknown,
  reason: FileErrorReason,
  message?: string
) {
  check(
    `refused as ${reason}`,
    value instanceof FileError && value.reason === reason,
    describe(value)
  );
  if (message !== undefined)
    check(
      'worded as expected',
      value instanceof Error && value.message === message,
      describe(value)
    );
}

export async function prepared(check: Check, file: File) {
  const value = await settle(prepareFile(file));
  check('prepared', value instanceof File, describe(value));
  return value instanceof File ? value : null;
}

export const uploader = (id: UploaderId) => {
  const el = document.querySelector<HTMLElement>(
    `[data-lab-uploader="${CSS.escape(id)}"]`
  );
  if (!el) throw new Error(`the ${id} uploader is not on the page`);
  return el;
};

export const fileInput = (id: UploaderId) =>
  uploader(id).querySelector<HTMLInputElement>('input[type="file"]');

/** What the file dialog does: sets the input's files and fires `change`. */
export function pick(id: UploaderId, files: File[]) {
  const input = fileInput(id);
  if (!input) throw new Error(`the ${id} uploader takes no files now`);
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export const filesOf = (id: UploaderId) => useLab.getState().files[id];

/** On screen and not on its way out. */
export const liveToasts = () => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-sonner-toast]:not([data-removed="true"])'
  ),
];

export const toastTexts = () => liveToasts().map((el) => el.textContent ?? '');

/** The toasts that appeared after `before` was taken. */
export const toastsAddedSince = (before: readonly Element[]) =>
  liveToasts()
    .filter((el) => !before.includes(el))
    .map((el) => el.textContent ?? '');

export const hasToast = (text: string) =>
  toastTexts().some((t) => t.includes(text));

/** Whether `url` still serves its blob; a revoked object URL fails to fetch. */
export async function isLive(url: string) {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

export const smallPng = (name: string) =>
  sampleImage(name, { width: 64, height: 48, type: 'image/png' });

const CLEAR_TIMEOUT_MS = 3000;

/**
 * Repeated: sonner applies a dismissal on the next animation frame, to the
 * toasts its Toaster holds then, and a toast raised just before is added on a
 * timer after it, so one dismiss can miss it.
 */
async function clearToasts() {
  const deadline = performance.now() + CLEAR_TIMEOUT_MS;
  while (liveToasts().length > 0 && performance.now() < deadline) {
    toast.dismiss();
    await wait(SETTLE_MS);
  }
}

async function reset() {
  closeAllDialogs();
  await clearToasts();
  remountUploaders();
  await wait(SETTLE_MS);
}

/** Timers and animation frames pause in a background tab, and toasts with them. */
function watchVisibility() {
  let hidden = document.hidden;
  const onChange = () => {
    if (document.hidden) hidden = true;
  };
  document.addEventListener('visibilitychange', onChange);
  return () => {
    document.removeEventListener('visibilitychange', onChange);
    return hidden;
  };
}

export async function runScenarios(scenarios: readonly Scenario[]) {
  if (useLab.getState().running) return;
  useLab.setState({ results: [] });
  const wasHidden = watchVisibility();
  try {
    for (const scenario of scenarios) {
      useLab.setState({ running: scenario.title });
      const check: Check = (name, ok, detail = '') =>
        useLab.setState((s) => ({
          results: [
            ...s.results,
            {
              group: scenario.group,
              check: `${scenario.title}: ${name}`,
              ok,
              detail,
            },
          ],
        }));
      try {
        await reset();
        await scenario.run(check);
      } catch (error) {
        check('ran to the end', false, String(error));
      }
    }
    await reset();
  } finally {
    if (wasHidden())
      useLab.setState((s) => ({
        results: [
          ...s.results,
          {
            group: 'Setup',
            check: 'the tab stayed in front while the scenarios ran',
            ok: false,
            detail: 'it went to the background: re-run with the tab visible',
          },
        ],
      }));
    useLab.setState({ running: null });
  }
}
