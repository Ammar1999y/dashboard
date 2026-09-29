import type { UploadedFile } from '@/types/upload';

export interface FileWithPreview {
  id: string;
  file: File | UploadedFile;
  preview?: string;
}
