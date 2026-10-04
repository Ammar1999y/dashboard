import type { Check, Scenario } from './harness';
import type { RealFile } from './real-files';

import imageCompression from 'browser-image-compression';
import { CustomError } from '@app/shared/error-class';
import { sanitizeFilename } from '@app/shared/filename';
import { SVG_MIME_TYPE } from '@app/shared/images/config';
import {
  MSG_INVALID_SVG,
  MSG_KIND_NOT_ALLOWED_HERE,
} from '@app/shared/messages/media';
import { MAX_IMAGE_SIZE, MIB } from '@app/shared/validation/constants';
import { DOCX_MIME_TYPE } from '@app/shared/validation/media-types';
import {
  MSG_FILE_INVALID_TYPE,
  MSG_FOR_FILE,
  MSG_IMAGE_UNSUPPORTED,
} from '@/constants/messages';
import { ACCEPT_IMAGES_WITH_SVG } from '@/lib/files/accept';
import {
  COMPRESSED_MAX_EDGE,
  compressionOptions,
  prepareFile,
} from '@/lib/files/prepare';
import { renderSvg } from '@/lib/files/render-svg';
import { uploadFile } from '@/lib/files/upload';

import { mediaConfig } from '@/components/editor/media-config';
import { getAcceptedFormats } from '@/components/shared/file-upload/file-utils';

import {
  describe,
  expectRefusal,
  filesOf,
  hasToast,
  pick,
  POLL_MS,
  settle,
  smallPng,
  toastTexts,
  uploader,
  wait,
  waitFor,
} from './harness';
import { useLab } from './lab-store';
import { REAL_FILES, realFile } from './real-files';
import {
  containsAscii,
  decodedSize,
  drawnPixels,
  meanDifference,
  psnr,
  sampleFile,
  withStallMeter,
} from './samples';
import { expectConverted, prepareNotingConversion } from './svg-scenarios';

/** Mean channel difference that still reads as the same picture. */
const SAME_PICTURE = 8;
/** Above this a photo shows visible compression damage. */
const MIN_PSNR_DB = 30;
/** Longer than this without a timer tick is a frozen page. */
const MAX_STALL_MS = 300;
/** The resolution a Safari user's photo should keep. */
const USABLE_EDGE = 1280;
const FIDELITY_EDGE = 256;
const EDITOR_TIMEOUT_MS = 15_000;
const TOAST_TIMEOUT_MS = 5000;

const RASTER_TYPES: ReadonlySet<string> = new Set(['image/webp', 'image/png']);

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** Whether this browser decodes `file` at all, which decides what it should get. */
const decodes = async (file: Blob) => (await decodedSize(file)) !== null;

async function expectSamePicture(
  check: Check,
  label: string,
  reference: Blob,
  candidate: Blob
) {
  const size = await decodedSize(reference);
  if (!size) {
    check(`${label}: the reference decodes`, false);
    return;
  }
  const [a, b] = await Promise.all([
    drawnPixels(reference, size.width, size.height),
    drawnPixels(candidate, size.width, size.height),
  ]);
  const difference = meanDifference(a, b);
  check(
    `${label}: looks the same (mean difference under ${SAME_PICTURE})`,
    difference < SAME_PICTURE,
    difference.toFixed(2)
  );
}

type SvgOutcome = 'native' | 'converted' | 'refused';

/** What the server's sanitizer decides for each, run under jsdom. */
const REAL_SVGS: readonly (readonly [RealFile, SvgOutcome])[] = [
  [REAL_FILES.svgFigmaSqids, 'native'],
  [REAL_FILES.svgFigmaSolidus, 'native'],
  [REAL_FILES.svgTux, 'native'],
  [REAL_FILES.svgIllustrator, 'converted'],
  [REAL_FILES.svgInkscape, 'converted'],
  [REAL_FILES.svgInkscapeLogo, 'converted'],
  [REAL_FILES.svgDoctype, 'refused'],
];

async function checkRealSvg(check: Check, real: RealFile, outcome: SvgOutcome) {
  const file = await realFile(real);
  const label = `${real.name} (${real.source})`;
  const prepared = await prepareNotingConversion(file);
  const { value } = prepared;

  if (outcome === 'refused') {
    expectRefusal(
      check,
      value,
      'invalid-svg',
      MSG_FOR_FILE(sanitizeFilename(real.name), MSG_INVALID_SVG)
    );
    return;
  }

  const reference = await renderSvg(await file.text(), FIDELITY_EDGE);
  if (outcome === 'converted') {
    await expectConverted(check, prepared, real.name);
    if (value instanceof File)
      await expectSamePicture(check, label, reference, value);
    return;
  }

  check(
    `${label}: stored as SVG`,
    value instanceof File && value.type === SVG_MIME_TYPE,
    describe(value)
  );
  if (!(value instanceof File)) return;
  const stored = await renderSvg(await value.text(), FIDELITY_EDGE);
  await expectSamePicture(check, label, reference, stored);
}

/** The dropzone's root, which carries its handlers and focus. */
const dropzone = (id: 'multi' | 'single') => {
  const root = uploader(id).querySelector<HTMLElement>('[role="button"]');
  if (!root) throw new Error(`the ${id} uploader has no dropzone now`);
  return root;
};

function drag(target: HTMLElement, type: string, files: File[]) {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  target.dispatchEvent(
    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer })
  );
}

const openDialogImage = () =>
  document.querySelector<HTMLImageElement>(
    '[role="dialog"][data-state="open"] img'
  );

const editorSurface = () =>
  document.querySelector<HTMLElement>(
    '[data-lab-editor] [contenteditable="true"]'
  );

/** A caret at the start of `surface`, which Slate reads on `selectionchange`. */
function placeCaret(surface: HTMLElement) {
  surface.focus();
  const range = document.createRange();
  range.selectNodeContents(surface);
  range.collapse(true);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export const REAL_FILE_SCENARIOS: Scenario[] = [
  {
    group: 'Real files',
    title: 'every real file downloads and matches its pinned hash',
    run: async (check) => {
      for (const real of Object.values(REAL_FILES)) {
        const value = await settle(realFile(real));
        check(real.name, value instanceof File, String(value));
      }
    },
  },
  {
    group: 'Real files',
    title:
      'a real HEIC: converted where this browser decodes HEIC, else told to convert it',
    run: async (check) => {
      for (const real of [REAL_FILES.heicCamera, REAL_FILES.heicNokiaStill]) {
        const file = await realFile(real);
        const value = await settle(prepareFile(file));
        if (await decodes(file)) {
          check(
            `${real.name}: this browser decodes HEIC, so it is converted`,
            value instanceof File && RASTER_TYPES.has(value.type),
            describe(value)
          );
          if (value instanceof File)
            check(
              `${real.name}: under the ceiling`,
              value.size <= MAX_IMAGE_SIZE * MIB,
              `${value.size}B`
            );
        } else {
          expectRefusal(
            check,
            value,
            'undecodable',
            MSG_IMAGE_UNSUPPORTED(sanitizeFilename(real.name))
          );
        }
      }
    },
  },
  {
    group: 'Real files',
    title: 'real animations (HEIC sequence, APNG, animated WebP) are refused',
    run: async (check) => {
      for (const real of [
        REAL_FILES.heicNokiaSequence,
        REAL_FILES.apng,
        REAL_FILES.animatedWebp,
      ])
        expectRefusal(
          check,
          await settle(prepareFile(await realFile(real))),
          'animated'
        );
    },
  },
  {
    group: 'Real files',
    title: 'EXIF orientation: a phone photo comes out the way it is shown',
    run: async (check) => {
      for (const real of [
        REAL_FILES.jpegOrientation6,
        REAL_FILES.jpegOrientation3,
      ]) {
        const original = await realFile(real);
        const output = await settle(prepareFile(original));
        if (!(output instanceof File)) {
          check(`${real.name}: prepared`, false, describe(output));
          continue;
        }
        // The browser applies EXIF orientation when it decodes for display.
        const shown = await decodedSize(original);
        const stored = await decodedSize(output);
        check(
          `${real.name}: same shape as shown`,
          shown !== null &&
            stored !== null &&
            shown.width > shown.height === stored.width > stored.height,
          `shown ${JSON.stringify(shown)} stored ${JSON.stringify(stored)}`
        );
        await expectSamePicture(check, real.name, original, output);
      }
    },
  },
  {
    group: 'Real files',
    title: 'camera metadata and GPS position are not uploaded',
    run: async (check) => {
      const original = await realFile(REAL_FILES.jpegGps);
      const before = await bytesOf(original);
      check(
        'the original carries GPS and camera data',
        containsAscii(before, 'GPS') || containsAscii(before, 'NIKON')
      );
      const output = await settle(prepareFile(original));
      if (!(output instanceof File)) {
        check('prepared', false, describe(output));
        return;
      }
      const after = await bytesOf(output);
      for (const marker of ['Exif', 'EXIF', 'GPS', 'NIKON', 'COOLPIX'])
        check(`no ${marker} in the upload`, !containsAscii(after, marker));
    },
  },
  {
    group: 'Real files',
    title: 'an 18 MP camera photo: under the ceiling, sharp, page responsive',
    run: async (check) => {
      const original = await realFile(REAL_FILES.jpegCamera18mp);
      const {
        result: output,
        longestStallMs,
        elapsedMs,
      } = await withStallMeter(() => settle(prepareFile(original)));
      if (!(output instanceof File)) {
        check('prepared', false, describe(output));
        return;
      }
      check(
        `at most ${MAX_IMAGE_SIZE} MiB`,
        output.size <= MAX_IMAGE_SIZE * MIB,
        `${output.size}B in ${(elapsedMs / 1000).toFixed(1)}s`
      );
      const size = await decodedSize(output);
      check(
        `longest edge at most ${COMPRESSED_MAX_EDGE}`,
        size !== null &&
          Math.max(size.width, size.height) <= COMPRESSED_MAX_EDGE,
        JSON.stringify(size)
      );
      if (size) {
        const [a, b] = await Promise.all([
          drawnPixels(original, size.width, size.height),
          drawnPixels(output, size.width, size.height),
        ]);
        const db = psnr(a, b);
        check(
          `sharp: PSNR at least ${MIN_PSNR_DB} dB`,
          db >= MIN_PSNR_DB,
          `${db.toFixed(1)} dB`
        );
      }
      check(
        `the page never froze for more than ${MAX_STALL_MS}ms`,
        longestStallMs <= MAX_STALL_MS,
        `${longestStallMs}ms`
      );
    },
  },
  {
    group: 'Real files',
    title: 'Safari’s path (no WebP encoder): the same photo as PNG',
    run: async (check) => {
      const original = await realFile(REAL_FILES.jpegCamera18mp);
      // What `prepareFile` gets on Safari, which hands back PNG for WebP.
      const png = await settle(
        imageCompression(original, {
          ...compressionOptions(),
          fileType: 'image/png',
        })
      );
      if (!(png instanceof Blob)) {
        check('encoded', false, String(png));
        return;
      }
      const size = await decodedSize(png);
      check(
        `fits ${MAX_IMAGE_SIZE} MiB as PNG`,
        png.size <= MAX_IMAGE_SIZE * MIB,
        `${png.size}B ${JSON.stringify(size)}`
      );
      check(
        `keeps at least ${USABLE_EDGE}px on its longest edge`,
        size !== null && Math.max(size.width, size.height) >= USABLE_EDGE,
        JSON.stringify(size)
      );
    },
  },
  {
    group: 'Real SVGs',
    title:
      'Figma, Illustrator and Inkscape exports: the server’s outcome, same picture',
    run: async (check) => {
      for (const [real, outcome] of REAL_SVGS)
        await checkRealSvg(check, real, outcome);
    },
  },
  {
    group: 'Interaction',
    title:
      'dragging files over the dropzone highlights it; a mixed drop keeps the images',
    run: async (check) => {
      const root = dropzone('multi');
      const png = await smallPng('dropped.png');
      const docx = sampleFile('notes.docx', 'PK', DOCX_MIME_TYPE);
      drag(root, 'dragenter', [png, docx]);
      check(
        'highlighted while dragging',
        await waitFor(() => root.className.includes('bg-primary/10'), 2000),
        root.className
      );
      drag(root, 'drop', [png, docx]);
      check(
        'the image is added',
        await waitFor(() => filesOf('multi').length === 1)
      );
      const message = MSG_FILE_INVALID_TYPE(
        sanitizeFilename(docx.name),
        getAcceptedFormats(ACCEPT_IMAGES_WITH_SVG)
      );
      check(
        'the document is refused with the formats',
        hasToast(message),
        toastTexts().join(' | ')
      );
    },
  },
  {
    group: 'Interaction',
    title: 'zoom opens the picture and back closes it; download keeps the name',
    run: async (check) => {
      pick('multi', [await smallPng('zoomed.png')]);
      await waitFor(() => filesOf('multi').length === 1);
      const [listed] = filesOf('multi');
      const card = uploader('multi');
      card.querySelector<HTMLElement>('button[aria-label="تكبير"]')?.click();
      check(
        'the zoom shows the preview',
        await waitFor(() => openDialogImage()?.src === listed?.preview, 3000),
        openDialogImage()?.src
      );
      history.back();
      check(
        'back closes it',
        await waitFor(() => openDialogImage() === null, 3000)
      );

      const saved: { link: HTMLAnchorElement | null } = { link: null };
      // Stops the download itself: only what it would save is read.
      const capture = (event: MouseEvent) => {
        if (!(event.target instanceof HTMLAnchorElement)) return;
        event.preventDefault();
        saved.link = event.target;
      };
      document.addEventListener('click', capture, { capture: true });
      try {
        card.querySelector<HTMLElement>('button[aria-label="تحميل"]')?.click();
      } finally {
        document.removeEventListener('click', capture, { capture: true });
      }
      const { link } = saved;
      check(
        'saved under its own name',
        listed?.file instanceof File && link?.download === listed.file.name,
        link?.download
      );
      check(
        'from the file in memory',
        link?.href.startsWith('blob:') === true,
        link?.href
      );
    },
  },
  {
    group: 'Interaction',
    title: 'the keyboard reaches the dropzone and opens the file picker',
    run: async (check) => {
      const root = dropzone('multi');
      check('focusable', root.tabIndex === 0, String(root.tabIndex));
      check(
        'announced as a button with a name',
        root.getAttribute('role') === 'button' &&
          (root.textContent?.trim().length ?? 0) > 0
      );
      const input =
        uploader('multi').querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error('no file input');
      let opened = 0;
      const block = (event: Event) => {
        event.preventDefault();
        opened += 1;
      };
      input.addEventListener('click', block, { capture: true });
      try {
        root.focus();
        for (const key of ['Enter', ' '])
          root.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              bubbles: true,
              cancelable: true,
            })
          );
        await wait(POLL_MS);
      } finally {
        input.removeEventListener('click', block, { capture: true });
      }
      check('Enter and Space each open it', opened === 2, String(opened));
    },
  },
  {
    group: 'Interaction',
    title:
      'an upload cancelled mid-way (dialog closed) ends with no error to show',
    run: async (check) => {
      const controller = new AbortController();
      const pending = settle(
        uploadFile(await realFile(REAL_FILES.jpegCamera18mp), {
          resource: 'media',
          signal: controller.signal,
        })
      );
      await wait(POLL_MS);
      controller.abort();
      const value = await pending;
      check(
        'rejects as an abort, which the upload hook keeps silent',
        value instanceof Error &&
          value.name === 'AbortError' &&
          !(value instanceof CustomError),
        describe(value)
      );
    },
  },
  {
    group: 'Interaction',
    title:
      'pasting an image into the editor: refused while editor media is off',
    run: async (check) => {
      if (mediaConfig.image.enabled) {
        check(
          'editor images are enabled: the Upload group covers the request',
          true
        );
        return;
      }
      useLab.setState({ editorMounted: true });
      try {
        check(
          'the editor mounts',
          await waitFor(() => editorSurface() !== null, EDITOR_TIMEOUT_MS)
        );
        const surface = editorSurface();
        if (!surface) return;
        placeCaret(surface);
        await wait(POLL_MS * 2);
        const clipboardData = new DataTransfer();
        clipboardData.items.add(await smallPng('pasted.png'));
        surface.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData,
            bubbles: true,
            cancelable: true,
          })
        );
        const message = MSG_FOR_FILE(
          sanitizeFilename('pasted.png'),
          MSG_KIND_NOT_ALLOWED_HERE
        );
        check(
          'the user is told images are not allowed here',
          await waitFor(() => hasToast(message), TOAST_TIMEOUT_MS),
          toastTexts().join(' | ')
        );
      } finally {
        useLab.setState({ editorMounted: false });
      }
    },
  },
];
