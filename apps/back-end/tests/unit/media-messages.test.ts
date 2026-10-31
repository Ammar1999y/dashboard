import { describe, expect, test } from 'bun:test';
import type { MediaRefusalReason } from '@app/shared/validation/media-types';

import {
  mediaMsg,
  MSG_ANIMATED_NOT_ALLOWED,
  MSG_DOCUMENT_TOO_LARGE,
  MSG_FILE_TOO_LARGE,
  MSG_FILE_TYPE_NOT_ALLOWED,
  uploadMsg,
} from '@app/shared/messages/media';

const FSI = String.fromCodePoint(0x20_68);
const PDI = String.fromCodePoint(0x20_69);
const REFUSAL_REASONS = [
  'signature',
  'container',
  'mismatch',
  'macros',
  'embedded',
  'encrypted',
  'complex',
] as const satisfies readonly MediaRefusalReason[];

describe('shared upload messages preserve the filename direction', () => {
  test.each(['1.png', 'ملف-1.png', 'report (2).pdf'])('%s', (name) => {
    const messages = [
      MSG_FILE_TOO_LARGE(name, 5),
      MSG_DOCUMENT_TOO_LARGE(name, 5),
      MSG_FILE_TYPE_NOT_ALLOWED(name),
      MSG_ANIMATED_NOT_ALLOWED(name),
      uploadMsg.contentMismatch(name),
      ...REFUSAL_REASONS.map((reason) => mediaMsg.refused(name, reason)),
    ];

    for (const message of messages) {
      expect(message).toContain(`${FSI}${name}${PDI}`);
      expect(message.split(FSI)).toHaveLength(2);
      expect(message.split(PDI)).toHaveLength(2);
    }
  });
});
