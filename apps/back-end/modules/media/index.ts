import {
  deleteMediaFilesBinding,
  getMediaFileBinding,
  moveMediaFilesBinding,
  publishMediaFileBinding,
  unpublishMediaFileBinding,
  updateMediaFileBinding,
  uploadMediaFileBinding,
} from './files';
import {
  createMediaFolderBinding,
  deleteMediaFolderBinding,
  getMediaFolderBinding,
  updateMediaFolderBinding,
} from './folders';
import {
  deleteMediaBinding,
  getMediaStatsBinding,
  listMediaBinding,
  moveMediaBinding,
  previewMediaDeleteBinding,
} from './library';
import { uploadRecordFileBinding } from './upload';

export const MEDIA_BINDINGS = [
  listMediaBinding,
  moveMediaBinding,
  deleteMediaBinding,
  previewMediaDeleteBinding,
  getMediaStatsBinding,
  uploadMediaFileBinding,
  moveMediaFilesBinding,
  deleteMediaFilesBinding,
  getMediaFileBinding,
  updateMediaFileBinding,
  publishMediaFileBinding,
  unpublishMediaFileBinding,
  createMediaFolderBinding,
  getMediaFolderBinding,
  updateMediaFolderBinding,
  deleteMediaFolderBinding,
  uploadRecordFileBinding,
];
