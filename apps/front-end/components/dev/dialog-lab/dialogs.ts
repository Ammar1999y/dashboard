import { createDialog, DIALOG_URL_IDS } from '@/lib/dialogs';

export interface LabRecord {
  id: number;
  name: string;
}

export const labOuter = createDialog({
  urlId: DIALOG_URL_IDS.labOuter,
  restoreFromUrl: true,
});

export const labInner = createDialog({
  urlId: DIALOG_URL_IDS.labInner,
  restoreFromUrl: true,
});

export const labSide = createDialog({
  urlId: DIALOG_URL_IDS.labSide,
  restoreFromUrl: true,
});

export const labRecord = createDialog<LabRecord>({
  urlId: DIALOG_URL_IDS.labRecord,
});

export const labLocal = createDialog();

export const LAB_PATH = '/dev/dialog-lab';
