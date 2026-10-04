import type { ContentDir } from '../styles';
import type { SlateEditor, Value } from 'platejs';

import { MarkdownPlugin } from '@platejs/markdown';
import { KEYS } from 'platejs';
import { getEditorDOMFromHtmlString, serializeHtml } from 'platejs/static';
import { CustomError } from '@app/shared/error-class';
import { MSG_POPUP_BLOCKED } from '@/constants/messages';
import { downloadBlob, openBlob } from '@/lib/files/download';

import { createPublishedEditor } from '../published';
import { DEFAULT_CONTENT_DIR, EXPORT_MEDIA_CARD_CLASS } from '../styles';
import { EditorStatic } from '../ui/static/editor-static';
import { DOCUMENT_CSS_URL, KATEX_CSS_URL } from './config';

export interface ExportOptions {
  dir?: ContentDir;
  /** Light unless asked: a printed or shared page reads as paper. */
  theme?: 'dark' | 'light';
  title?: string;
}

const EXPORT_FILE_NAME = 'document';
const FONT_URL =
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700&display=swap';

const stylesheets = new Map<string, Promise<string>>();

/** Fetched once per page; a failed fetch is retried on the next export. */
function loadStylesheet(url: string) {
  let css = stylesheets.get(url);
  if (!css) {
    css = fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
      }
      return response.text();
    });
    css.catch(() => stylesheets.delete(url));
    stylesheets.set(url, css);
  }
  return css;
}

const MATH_TYPES = new Set<string>([KEYS.equation, KEYS.inlineEquation]);

function hasMath(nodes: readonly unknown[]): boolean {
  return nodes.some(
    (node) =>
      typeof node === 'object' &&
      node !== null &&
      (('type' in node &&
        typeof node.type === 'string' &&
        MATH_TYPES.has(node.type)) ||
        ('children' in node &&
          Array.isArray(node.children) &&
          hasMath(node.children)))
  );
}

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const serializeBody = (editor: SlateEditor, dir: ContentDir) =>
  serializeHtml(editor, { editorComponent: EditorStatic, props: { dir } });

/** The published document's body alone, as the static renderers draw it. */
export async function renderEditorBody(
  value: Value,
  dir: ContentDir = DEFAULT_CONTENT_DIR
) {
  return serializeBody(createPublishedEditor(value), dir);
}

/**
 * A standalone page: `html` is right-to-left like the app, so the `rtl:`
 * utilities resolve as they do there, and the content root carries `dir`.
 */
export async function buildEditorDocument(
  value: Value,
  {
    dir = DEFAULT_CONTENT_DIR,
    theme = 'light',
    title = EXPORT_FILE_NAME,
  }: ExportOptions = {}
) {
  const editor = createPublishedEditor(value);
  const [body, css, katex] = await Promise.all([
    serializeBody(editor, dir),
    loadStylesheet(DOCUMENT_CSS_URL),
    hasMath(editor.children) ? loadStylesheet(KATEX_CSS_URL) : '',
  ]);

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="${theme}" />
    <title>${escapeHtml(title)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="${FONT_URL}" />
    <style>${css}${katex}:root{--font-main:'Cairo'}</style>
  </head>
  <body>${body}</body>
</html>`;
}

/** Reads an HTML file into nodes, whether this editor exported it or not. */
export function deserializeEditorHtml(editor: SlateEditor, html: string) {
  // Our export wraps the content in its editor root, beside the toggle rules;
  // anything else is read from the whole body.
  const element =
    getEditorDOMFromHtmlString(html) ??
    new DOMParser().parseFromString(html, 'text/html').body;
  return editor.api.html.deserialize({ element });
}

export async function downloadEditorHtml(
  value: Value,
  options?: ExportOptions
) {
  const html = await buildEditorDocument(value, options);
  downloadBlob(
    new Blob([html], { type: 'text/html' }),
    `${EXPORT_FILE_NAME}.html`
  );
}

export async function printEditorDocument(
  value: Value,
  options?: ExportOptions
) {
  const html = await buildEditorDocument(value, options);
  const printWindow = openBlob(new Blob([html], { type: 'text/html' }));
  if (!printWindow) throw new CustomError(MSG_POPUP_BLOCKED);
  printWindow.addEventListener('load', () => printWindow.print());
}

const CAPTURE_WIDTH = 800;

/** Draws the exported page, laid out off-screen, so it matches the HTML export. */
async function captureDocument(value: Value, options?: ExportOptions) {
  const html = await buildEditorDocument(value, options);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    border: '0',
    height: '0',
    left: '-10000px',
    position: 'fixed',
    top: '0',
    width: `${CAPTURE_WIDTH}px`,
  });
  const loaded = new Promise((resolve) =>
    frame.addEventListener('load', resolve, { once: true })
  );
  frame.srcdoc = html;
  document.body.append(frame);
  try {
    await loaded;
    const page = frame.contentDocument;
    if (!page) throw new Error('the capture frame has no document');
    prepareCaptureDocument(page);
    await page.fonts.ready;
    const height = page.documentElement.scrollHeight;
    frame.style.height = `${height}px`;
    const { default: html2canvas } = await import('html2canvas-pro');
    return await html2canvas(page.body, {
      windowHeight: height,
      windowWidth: CAPTURE_WIDTH,
    });
  } finally {
    frame.remove();
  }
}

export function prepareCaptureDocument(page: Document) {
  for (const toggle of page.querySelectorAll<HTMLInputElement>(
    'input[id^="editor-toggle-"]'
  )) {
    toggle.checked = true;
  }

  for (const media of page.querySelectorAll<HTMLElement>(
    '[data-export-media-url]'
  )) {
    const card = page.createElement('div');
    const title = page.createElement('strong');
    title.textContent = media.dataset.exportMediaLabel ?? '';
    const url = page.createElement('div');
    url.textContent = media.dataset.exportMediaUrl ?? '';
    url.dir = 'ltr';
    card.className = EXPORT_MEDIA_CARD_CLASS;
    card.append(title, url);
    const caption = media.querySelector('figcaption');
    if (caption) card.append(caption);
    media.replaceChildren(card);
  }

  for (const link of page.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href');
    if (!href || link.textContent?.includes(href)) continue;
    const url = page.createElement('bdi');
    url.dir = 'ltr';
    url.textContent = ` (${href})`;
    link.append(url);
  }
}

export async function downloadEditorImage(
  value: Value,
  options?: ExportOptions
) {
  const canvas = await captureDocument(value, options);
  const png = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png')
  );
  if (!png) throw new Error('the canvas produced no image');
  downloadBlob(png, `${EXPORT_FILE_NAME}.png`);
}

export async function downloadEditorPdf(value: Value, options?: ExportOptions) {
  const canvas = await captureDocument(value, options);
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(canvas.toDataURL('image/png'));
  const { height, width } = image.scale(1);
  pdf.addPage([width, height]).drawImage(image, { height, width, x: 0, y: 0 });
  downloadBlob(
    new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' }),
    `${EXPORT_FILE_NAME}.pdf`
  );
}

export function downloadEditorMarkdown(value: Value) {
  const markdown = createPublishedEditor(value)
    .getApi(MarkdownPlugin)
    .markdown.serialize();
  downloadBlob(
    new Blob([markdown], { type: 'text/markdown' }),
    `${EXPORT_FILE_NAME}.md`
  );
}
