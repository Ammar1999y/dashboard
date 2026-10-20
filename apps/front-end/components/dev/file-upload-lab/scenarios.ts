import type { Scenario } from './harness';

import { uploadRecordFile } from '@app/shared/api/media';
import { sanitizeFilename } from '@app/shared/filename';
import { MSG_ANIMATED_NOT_ALLOWED } from '@app/shared/messages/media';
import {
  MAX_DOCUMENT_SIZE_MB,
  MAX_IMAGE_SIZE,
  MIB,
} from '@app/shared/validation/constants';
import { DOCX_MIME_TYPE } from '@app/shared/validation/media-types';
import {
  MSG_FILE_INVALID_TYPE,
  MSG_IMAGE_UNSUPPORTED,
  MSG_TOO_MANY_FILES,
} from '@/constants/messages';
import { ACCEPT_IMAGES, INPUT_MAX_SIZE_MB } from '@/lib/files/accept';
import { COMPRESSION_LIB_URL } from '@/lib/files/config';
import { readImageHeader } from '@/lib/files/image-header';
import {
  COMPRESSED_MAX_EDGE,
  compressionOptions,
  FileError,
  prepareFile,
} from '@/lib/files/prepare';
import { uploadFile } from '@/lib/files/upload';

import { getAcceptedFormats } from '@/components/shared/file-upload/file-utils';

import {
  ANIMATED_PNG,
  ANIMATED_WEBP,
  FRAMELESS_JPEG,
  GIF,
  HEADLESS_PNG,
  heicHeader,
  jpegHeader,
  pngHeader,
} from './fixtures';
import {
  describe,
  expectRefusal,
  fileInput,
  filesOf,
  hasToast,
  isLive,
  liveToasts,
  pick,
  POLL_MS,
  PREPARE_TIMEOUT_MS,
  prepared,
  settle,
  SETTLE_MS,
  smallPng,
  toastsAddedSince,
  toastTexts,
  uploader,
  wait,
  waitFor,
} from './harness';
import { remountUploaders } from './lab-store';
import { REAL_FILE_SCENARIOS } from './real-file-scenarios';
import {
  decodedSize,
  photoLikePng,
  sampleFile,
  sampleImage,
  sizedFile,
} from './samples';
import { SVG_SCENARIOS } from './svg-scenarios';

/** Header checks run before any decode, so they answer at once. */
const HEADER_CHECK_MS = 250;

const WORKER_TIMEOUT_MS = 5000;

/** What `typeof imageCompression` is in a `blob:` worker after `importScripts(url)`. */
async function libraryInBlobWorker(url: string): Promise<string> {
  const source = `try { importScripts(${JSON.stringify(url)}); postMessage(typeof imageCompression); } catch (error) { postMessage('failed: ' + error.message); }`;
  const workerUrl = URL.createObjectURL(
    new Blob([source], { type: 'text/javascript' })
  );
  const worker = new Worker(workerUrl);
  try {
    return await Promise.race([
      new Promise<string>((resolve) =>
        worker.addEventListener(
          'message',
          (event: MessageEvent<unknown>) => resolve(String(event.data)),
          { once: true }
        )
      ),
      wait(WORKER_TIMEOUT_MS).then(() => 'no answer'),
    ]);
  } finally {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
}

const uploadRequests = () =>
  performance
    .getEntriesByType('resource')
    .filter((entry) => entry.name.includes(uploadRecordFile.path)).length;

/** Admitted (under the input limit) yet over the server ceiling: it must compress. */
const photoSized = (name: string) =>
  photoLikePng(name, MAX_IMAGE_SIZE * MIB + 1, INPUT_MAX_SIZE_MB.raster * MIB);

const PIPELINE_SCENARIOS: Scenario[] = [
  {
    group: 'Setup',
    title: 'The compression worker is served from this origin',
    run: async (check) => {
      const response = await settle(fetch(COMPRESSION_LIB_URL));
      check(
        `${COMPRESSION_LIB_URL} answers 200`,
        response instanceof Response && response.ok,
        String(response instanceof Response ? response.status : response)
      );
    },
  },
  {
    group: 'Setup',
    title: 'The library loads inside a blob: worker, as the library starts one',
    run: async (check) => {
      const answer = await libraryInBlobWorker(
        compressionOptions().libURL ?? ''
      );
      check(
        'importScripts defines imageCompression',
        answer === 'function',
        answer
      );
    },
  },
  {
    group: 'Images',
    title: 'A photo-sized PNG becomes a WebP under the server ceiling',
    run: async (check) => {
      const input = await photoSized('photo.png');
      check(
        'input is over the ceiling',
        input.size > MAX_IMAGE_SIZE * MIB,
        `${input.size}B`
      );
      const output = await prepared(check, input);
      if (!output) return;
      // Safari 15 cannot encode WebP from a canvas; PNG is the fallback.
      check(
        'encoded as WebP (PNG where the browser has no WebP encoder)',
        output.type === 'image/webp' || output.type === 'image/png',
        output.type
      );
      check(
        'named after the output type',
        output.name === `photo.${output.type.slice('image/'.length)}`,
        output.name
      );
      check(
        `at most ${MAX_IMAGE_SIZE} MiB`,
        output.size <= MAX_IMAGE_SIZE * MIB,
        `${output.size}B`
      );
      const size = await decodedSize(output);
      check(
        `longest edge at most ${COMPRESSED_MAX_EDGE}`,
        size !== null &&
          Math.max(size.width, size.height) <= COMPRESSED_MAX_EDGE,
        JSON.stringify(size)
      );
      check(
        'its header agrees with the decoder',
        JSON.stringify(
          readImageHeader(new Uint8Array(await output.arrayBuffer()))?.size
        ) === JSON.stringify(size)
      );
    },
  },
  {
    group: 'Images',
    title: 'A JPEG is converted, not stored as JPEG',
    run: async (check) => {
      const input = await sampleImage('camera.jpg', {
        width: 1600,
        height: 1200,
        type: 'image/jpeg',
      });
      const output = await prepared(check, input);
      check(
        'no longer a JPEG',
        output !== null && output.type !== 'image/jpeg',
        output?.type
      );
    },
  },
  {
    group: 'Images',
    title: 'An empty-typed image is read by its extension',
    run: async (check) => {
      const png = await smallPng('logo.png');
      const output = await prepared(check, sampleFile('logo.png', png));
      check(
        'typed on the way out',
        output?.type.startsWith('image/') === true,
        output?.type
      );
    },
  },
  {
    group: 'Images',
    title: 'A prepared file is not prepared again',
    run: async (check) => {
      const output = await prepared(check, await smallPng('once.png'));
      if (!output) return;
      check('returned as it is', (await prepareFile(output)) === output);
    },
  },
  {
    group: 'Refusals',
    title: 'Animated images are refused, not flattened',
    run: async (check) => {
      for (const [name, bytes, type] of [
        ['anim.png', ANIMATED_PNG, 'image/png'],
        ['anim.webp', ANIMATED_WEBP, 'image/webp'],
        ['anim.heic', heicHeader([[10, 10]], { sequence: true }), ''],
      ] as const) {
        const value = await settle(prepareFile(sampleFile(name, bytes, type)));
        expectRefusal(
          check,
          value,
          'animated',
          MSG_ANIMATED_NOT_ALLOWED(sanitizeFilename(name))
        );
      }
    },
  },
  {
    group: 'Refusals',
    title: 'Pixel bombs are refused from the header, before any decode',
    run: async (check) => {
      for (const [name, bytes, type] of [
        ['bomb.png', pngHeader(20_000, 20_000), 'image/png'],
        [
          'bomb.jpg',
          jpegHeader(20_000, 20_000, { thumbnail: true }),
          'image/jpeg',
        ],
        [
          'bomb.heic',
          heicHeader([
            [512, 512],
            [20_000, 20_000],
          ]),
          '',
        ],
      ] as const) {
        const start = performance.now();
        const value = await settle(prepareFile(sampleFile(name, bytes, type)));
        const elapsed = Math.round(performance.now() - start);
        expectRefusal(check, value, 'too-large');
        check(
          `${name} answered in under ${HEADER_CHECK_MS}ms`,
          elapsed < HEADER_CHECK_MS,
          `${elapsed}ms`
        );
      }
    },
  },
  {
    group: 'Refusals',
    title: 'An unreadable header is refused, never treated as unlimited',
    run: async (check) => {
      for (const [name, bytes] of [
        ['headless.png', HEADLESS_PNG],
        ['frameless.jpg', FRAMELESS_JPEG],
        ['empty.heic', heicHeader([])],
      ] as const) {
        expectRefusal(
          check,
          await settle(prepareFile(sampleFile(name, bytes))),
          'undecodable'
        );
      }
    },
  },
  {
    group: 'Refusals',
    title: 'A broken image fails clearly, with no original sent instead',
    run: async (check) => {
      // A readable header over image data no decoder accepts.
      const value = await settle(
        prepareFile(sampleFile('broken.png', pngHeader(100, 100), 'image/png'))
      );
      expectRefusal(
        check,
        value,
        'undecodable',
        MSG_IMAGE_UNSUPPORTED('broken')
      );
    },
  },
  {
    group: 'Refusals',
    title: 'A HEIC this browser cannot decode says to convert it',
    run: async (check) => {
      const value = await settle(
        prepareFile(sampleFile('IMG_0001.HEIC', heicHeader([[4032, 3024]])))
      );
      expectRefusal(
        check,
        value,
        'undecodable',
        MSG_IMAGE_UNSUPPORTED('IMG_0001')
      );
    },
  },
  {
    group: 'Refusals',
    title: 'Bytes that are no image the pipeline reads are refused',
    run: async (check) => {
      expectRefusal(
        check,
        await settle(prepareFile(sampleFile('cat.jpg', GIF, 'image/jpeg'))),
        'unsupported-type'
      );
    },
  },
  {
    group: 'Documents',
    title: 'Documents pass byte for byte, under their resolved type',
    run: async (check) => {
      const output = await prepared(check, sampleFile('report.docx', 'PK'));
      check('typed as DOCX', output?.type === DOCX_MIME_TYPE, output?.type);
      check('content unchanged', (await output?.text()) === 'PK');
    },
  },
  {
    group: 'Documents',
    title: 'Disabled, unknown and oversized documents are refused',
    run: async (check) => {
      expectRefusal(
        check,
        await settle(prepareFile(sampleFile('old.doc', 'x'))),
        'unsupported-type'
      );
      expectRefusal(
        check,
        await settle(prepareFile(sampleFile('setup.exe', 'x'))),
        'unsupported-type'
      );
      const big = sizedFile(
        'big.pdf',
        MAX_DOCUMENT_SIZE_MB * MIB + 1,
        'application/pdf'
      );
      expectRefusal(check, await settle(prepareFile(big)), 'too-large');
    },
  },
  {
    group: 'Documents',
    title: 'A kind the caller does not take is refused',
    run: async (check) => {
      const png = await smallPng('logo.png');
      expectRefusal(
        check,
        await settle(prepareFile(png, { kinds: ['document'] })),
        'kind-not-allowed'
      );
      // The editor's own gate while its media types are disabled.
      expectRefusal(
        check,
        await settle(prepareFile(png, { kinds: [] })),
        'kind-not-allowed'
      );
    },
  },
  {
    group: 'Abort',
    title: 'An abort settles, before or during compression',
    run: async (check) => {
      const before = new AbortController();
      before.abort();
      const early = await settle(
        prepareFile(await smallPng('a.png'), { signal: before.signal })
      );
      check(
        'aborted before: rejects, not as a FileError',
        early instanceof Error && !(early instanceof FileError),
        describe(early)
      );

      const during = new AbortController();
      const big = await photoSized('big.png');
      const pending = settle(prepareFile(big, { signal: during.signal }));
      await wait(POLL_MS);
      during.abort();
      const late = await Promise.race([
        pending,
        wait(PREPARE_TIMEOUT_MS).then(() => 'hung'),
      ]);
      check('aborted during: settles', late !== 'hung', describe(late));
      check(
        'aborted during: not a FileError',
        !(late instanceof FileError),
        describe(late)
      );
    },
  },
  {
    group: 'Component',
    title: 'Picked images get a card and a live preview each',
    run: async (check) => {
      pick('multi', [await smallPng('one.png'), await smallPng('two.png')]);
      check(
        'two files listed',
        await waitFor(() => filesOf('multi').length === 2),
        String(filesOf('multi').length)
      );
      const previews = filesOf('multi').map((f) => f.preview ?? '');
      check(
        'each has an object URL',
        previews.every((url) => url.startsWith('blob:')),
        previews.join(' ')
      );
      const live = await Promise.all(previews.map(isLive));
      check('each preview loads', live.every(Boolean));
      check(
        'two cards rendered',
        uploader('multi').querySelectorAll('img').length === 2
      );
    },
  },
  {
    group: 'Component',
    title: 'More files than the limit at once: the first three, one toast',
    run: async (check) => {
      const files = await Promise.all(
        [1, 2, 3, 4].map((n) => smallPng(`${n}.png`))
      );
      pick('multi', files);
      check(
        'toast names the limit',
        await waitFor(() => hasToast(MSG_TOO_MANY_FILES(3)), 3000),
        toastTexts().join(' | ')
      );
      check(
        'the first three added',
        await waitFor(() => filesOf('multi').length === 3),
        filesOf('multi')
          .map(({ file }) => (file instanceof File ? file.name : file.id))
          .join(', ')
      );
      check(
        'one toast, not one per extra file',
        toastTexts().filter((t) => t.includes(MSG_TOO_MANY_FILES(3))).length ===
          1
      );
    },
  },
  {
    group: 'Component',
    title: 'Filling the last slots: the rest refused with one toast',
    run: async (check) => {
      pick('multi', [await smallPng('1.png'), await smallPng('2.png')]);
      await waitFor(() => filesOf('multi').length === 2);
      pick('multi', [await smallPng('3.png'), await smallPng('4.png')]);
      check(
        'filled to three',
        await waitFor(() => filesOf('multi').length === 3),
        String(filesOf('multi').length)
      );
      check(
        'toast names the limit',
        hasToast(MSG_TOO_MANY_FILES(3)),
        toastTexts().join(' | ')
      );
    },
  },
  {
    group: 'Component',
    title: 'A type the dropzone does not take is refused with its formats',
    run: async (check) => {
      pick('single', [sampleFile('report.docx', 'PK', DOCX_MIME_TYPE)]);
      const message = MSG_FILE_INVALID_TYPE(
        'report',
        getAcceptedFormats(ACCEPT_IMAGES)
      );
      check(
        'toast lists the formats',
        await waitFor(() => hasToast(message), 3000),
        toastTexts().join(' | ')
      );
      check('nothing added', filesOf('single').length === 0);
    },
  },
  {
    group: 'Component',
    title: 'A refused file toasts its reason and adds no card',
    run: async (check) => {
      pick('multi', [sampleFile('anim.png', ANIMATED_PNG, 'image/png')]);
      check(
        'toast says why',
        await waitFor(() => hasToast(MSG_ANIMATED_NOT_ALLOWED('anim')), 5000),
        toastTexts().join(' | ')
      );
      check('nothing added', filesOf('multi').length === 0);
    },
  },
  {
    group: 'Component',
    title: 'Removing a card frees its preview',
    run: async (check) => {
      pick('multi', [await smallPng('one.png'), await smallPng('two.png')]);
      await waitFor(() => filesOf('multi').length === 2);
      const [first] = filesOf('multi');
      const remove = uploader('multi').querySelector<HTMLElement>(
        'button[aria-label="حذف"]'
      );
      if (!remove || !first?.preview) throw new Error('no card to remove');
      remove.click();
      check(
        'one left',
        await waitFor(() => filesOf('multi').length === 1, 3000)
      );
      await wait(SETTLE_MS);
      check('its preview is revoked', !(await isLive(first.preview)));
    },
  },
  {
    group: 'Component',
    title: 'Unmounting frees every preview',
    run: async (check) => {
      pick('multi', [await smallPng('one.png')]);
      await waitFor(() => filesOf('multi').length === 1);
      const url = filesOf('multi')[0]?.preview ?? '';
      remountUploaders();
      await wait(SETTLE_MS);
      check('the preview is revoked', url !== '' && !(await isLive(url)), url);
    },
  },
  {
    group: 'Component',
    title: 'Single mode takes no second file',
    run: async (check) => {
      pick('single', [await smallPng('only.png')]);
      check(
        'one file listed',
        await waitFor(() => filesOf('single').length === 1)
      );
      check('the picker is gone', fileInput('single') === null);
    },
  },
  {
    group: 'Component',
    title: 'Unmounting mid-compression adds nothing and says nothing',
    run: async (check) => {
      const file = await photoSized('big.png');
      const before = liveToasts();
      pick('multi', [file]);
      await wait(POLL_MS);
      remountUploaders();
      await wait(3000);
      const added = toastsAddedSince(before);
      check('no toast', added.length === 0, added.join(' | '));
      check('nothing listed', filesOf('multi').length === 0);
    },
  },
  {
    group: 'Component',
    title: 'The helper text states each kind’s own limit',
    run: async (check) => {
      const text = uploader('multi').textContent ?? '';
      check(
        `photos ${INPUT_MAX_SIZE_MB.raster} MB`,
        text.includes(`${INPUT_MAX_SIZE_MB.raster} MB`),
        text
      );
      check(
        `SVG ${INPUT_MAX_SIZE_MB.svg} MB`,
        text.includes(`${INPUT_MAX_SIZE_MB.svg} MB`),
        text
      );
      const docs = uploader('documents').textContent ?? '';
      check(
        `documents ${INPUT_MAX_SIZE_MB.document} MB`,
        docs.includes(`${INPUT_MAX_SIZE_MB.document} MB`),
        docs
      );
    },
  },
  {
    group: 'Upload',
    title: 'A refused file never reaches the server',
    run: async (check) => {
      const before = uploadRequests();
      const value = await settle(
        uploadFile(sampleFile('anim.png', ANIMATED_PNG, 'image/png'), {
          resource: 'media',
        })
      );
      expectRefusal(check, value, 'animated');
      check('no upload request', uploadRequests() === before);
    },
  },
];

export const SCENARIOS: Scenario[] = [
  ...PIPELINE_SCENARIOS,
  ...SVG_SCENARIOS,
  ...REAL_FILE_SCENARIOS,
];

export const GROUPS = [...new Set(SCENARIOS.map((s) => s.group))];
