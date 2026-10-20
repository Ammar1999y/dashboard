import type { ItemKey } from '@/lib/media/keys';
import type { SelectionColumn } from '@/lib/media/selection';
import type { EntityID } from '@app/shared/types';

import { createDialog } from '@/lib/dialogs';

// None has a `urlId`: each carries data, which a shared link could not.

/** A write that asks first: the dialog runs it and stays until it succeeds. */
export interface ConfirmRequest {
  title: string;
  description: string;
  /** Said apart from the description: what the action cannot take back. */
  warning?: string;
  confirmLabel: string;
  pendingLabel: string;
  destructive?: boolean;
  run: () => Promise<{ message: string }>;
  onDone?: () => void;
}

export const confirmDialog = createDialog<ConfirmRequest>();

/** A question before something the user may not expect; `answer` hears the reply. */
export interface AskRequest {
  title: string;
  message: string;
  confirmLabel: string;
  answer: (confirmed: boolean) => void;
}

export const askDialog = createDialog<AskRequest>();

export const deleteDialog = createDialog<{ keys: readonly ItemKey[] }>();

/** After a delete the server refused because records use some of the files. */
export const inUseDialog = createDialog<{
  /** Every item of the refused runs. */
  refused: readonly ItemKey[];
  /** Those the refusal named as used. */
  inUse: readonly EntityID[];
  message: string;
  /** Whether the refused delete reached inside folders, as a retry must. */
  recursive: boolean;
}>();

export const pdfPreviewDialog = createDialog<{ id: EntityID }>();

/** Where an upload aimed at the root goes: files live in folders. */
export const folderPickerDialog = createDialog<{
  onPick: (folder: EntityID, name: string) => void;
}>();

export const shortcutsDialog = createDialog();

/** Quick look over the files of one list, from `index`. */
export const quickLookDialog = createDialog<{
  keys: readonly ItemKey[];
  index: number;
  col: SelectionColumn;
}>();
