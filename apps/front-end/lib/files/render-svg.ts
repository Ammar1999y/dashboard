import { SVG_MIME_TYPE, SVG_NAMESPACE } from '@app/shared/images/config';

/** A `viewBox`'s width and height, when it has four numbers and both are positive. */
export function viewBoxSize(
  viewBox: string | null
): { width: number; height: number } | null {
  const parts =
    viewBox
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const width = parts[2] ?? 0;
  const height = parts[3] ?? 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

const ABSOLUTE_UNIT = /(?:px|pt|pc|mm|cm|in)$/i;
const NUMBER_CHARACTERS = /^\+?[\d.e+-]+$/i;

/**
 * A length an image renders at by itself. A percentage, a font-relative unit or
 * no value leaves the size to the browser, which differs between browsers.
 */
export function isIntrinsicLength(value: string | null): boolean {
  const trimmed = value?.trim() ?? '';
  const unit = ABSOLUTE_UNIT.exec(trimmed)?.[0] ?? '';
  const number = trimmed.slice(0, trimmed.length - unit.length);
  return (
    NUMBER_CHARACTERS.test(number) &&
    Number.isFinite(Number(number)) &&
    Number(number) >= 0
  );
}

/**
 * `width` × `height` with the longest side brought within `minEdge` and
 * `maxEdge`. Up as well as down: the source is a vector.
 */
export function scaledSize(
  width: number,
  height: number,
  maxEdge: number,
  minEdge = 0
): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = Math.min(maxEdge, Math.max(minEdge, longest)) / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** `node`, with every element in no namespace moved into the SVG one. */
function inSvgNamespace(node: Node, owner: XMLDocument): Node {
  if (!(node instanceof Element) || node.namespaceURI !== null)
    return owner.importNode(node, true);
  const element = owner.createElementNS(SVG_NAMESPACE, node.localName);
  for (const { name, namespaceURI, value } of node.attributes)
    if (name !== 'xmlns') element.setAttributeNS(namespaceURI, name, value);
  for (const child of node.childNodes)
    element.append(inSvgNamespace(child, owner));
  return element;
}

/**
 * `source` with a root `width` and `height` an image renders at, taken from the
 * `viewBox` when either is missing or relative; `null` with no size to take. A
 * root without `xmlns` is native (DOMPurify's re-parse supplies it) but renders
 * nothing as an image, so it is rebuilt in the SVG namespace. Re-serialized
 * only when changed, so CDATA and comments reach the renderer.
 */
function withIntrinsicSize(source: string): string | null {
  const parsed = new DOMParser().parseFromString(source, SVG_MIME_TYPE);
  const sized =
    isIntrinsicLength(parsed.documentElement.getAttribute('width')) &&
    isIntrinsicLength(parsed.documentElement.getAttribute('height'));
  const namespaced = parsed.documentElement.namespaceURI === SVG_NAMESPACE;
  if (sized && namespaced) return source;

  let doc: XMLDocument = parsed;
  if (!namespaced) {
    doc = document.implementation.createDocument(SVG_NAMESPACE, null);
    doc.append(inSvgNamespace(parsed.documentElement, doc));
  }
  if (!sized) {
    const root = doc.documentElement;
    const size = viewBoxSize(root.getAttribute('viewBox'));
    if (size === null) return null;
    root.setAttribute('width', String(size.width));
    root.setAttribute('height', String(size.height));
  }
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Renders `source` as an IMAGE, never into the page, to a PNG whose longest
 * side is brought within `minEdge` and `maxEdge`. An image runs no script and
 * loads nothing, so the markup reaches the upload only as pixels.
 *
 * Rejects with a plain `Error` on anything the browser cannot do (decode,
 * a canvas the SVG tainted, export); the caller decides what the user is told.
 * Nothing interrupts the browser's own rendering once started.
 */
export async function renderSvg(
  source: string,
  maxEdge: number,
  minEdge = 0
): Promise<Blob> {
  const sized = withIntrinsicSize(source);
  if (sized === null) throw new Error('the SVG has no size to render at');

  const url = URL.createObjectURL(new Blob([sized], { type: SVG_MIME_TYPE }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    const { naturalWidth: width, naturalHeight: height } = image;
    if (!(width > 0 && height > 0))
      throw new Error('the SVG rendered at no size');
    const size = scaledSize(width, height, maxEdge, minEdge);

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2D canvas context');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error('the canvas exported nothing')),
        'image/png'
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
