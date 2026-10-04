import type { FileWithPreview } from '@/components/shared/file-upload';

import { create } from 'zustand';

interface LabResult {
  group: string;
  check: string;
  ok: boolean;
  detail: string;
}

/** The `FileUpload`s on the page, each as a dashboard form configures one. */
export type UploaderId = 'multi' | 'single' | 'documents';

interface LabState {
  running: string | null;
  results: LabResult[];
  /** What each uploader last reported through `onFilesChange`. */
  files: Record<UploaderId, FileWithPreview[]>;
  /** Remounts every uploader empty. */
  uploadersKey: number;
  /** The real editor, mounted only for the scenario that pastes into it. */
  editorMounted: boolean;
}

const NO_FILES: Record<UploaderId, FileWithPreview[]> = {
  multi: [],
  single: [],
  documents: [],
};

export const useLab = create<LabState>(() => ({
  running: null,
  results: [],
  files: NO_FILES,
  uploadersKey: 0,
  editorMounted: false,
}));

export const remountUploaders = () =>
  useLab.setState((s) => ({
    files: NO_FILES,
    uploadersKey: s.uploadersKey + 1,
  }));

export const reportFiles = (id: UploaderId, files: FileWithPreview[]) =>
  useLab.setState((s) => ({ files: { ...s.files, [id]: files } }));
