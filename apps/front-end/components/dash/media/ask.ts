import { MSG_PASTE_FOLDERS_ONLY } from '@/constants/messages';

import { askDialog } from './dialogs';

/** Resolves with the user's answer to `askDialog`; closing it is a no. */
const ask = (
  request: Omit<Parameters<typeof askDialog.open>[0], 'answer'>
): Promise<boolean> =>
  new Promise((resolve) => askDialog.open({ ...request, answer: resolve }));

/** A paste at the root moves the folders and keeps the files cut: the user agrees first. */
export const askForFoldersOnly = (folders: number, files: number) =>
  ask({
    title: 'لصق المجلدات فقط',
    message: MSG_PASTE_FOLDERS_ONLY(folders, files),
    confirmLabel: 'لصق المجلدات',
  });
