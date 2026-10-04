import type { MediaFile } from '@/lib/files/upload';

export interface FileWithPreview {
  id: string;
  file: File | MediaFile;
  preview?: string;
}
