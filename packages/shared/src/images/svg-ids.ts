import {
  canonicalLocalUrls,
  fragmentId,
  isPresentationAttribute,
  urlTargets,
} from './config';

const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * What every later stage reads back as the id it was written as. Anything else
 * (a quote, a parenthesis, a space, `%`, `#`, a line break, `url(` text) is
 * spelled in a reference only through an encoding that the optimizer's
 * reference pattern or the value checks can misread, and a misread reference
 * costs the definition it names.
 */
const PLAIN_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const GENERATED_PREFIX = 'sid-';
/**
 * The namespace clause is not redundant: the xlink prefix is the author's
 * choice, and Sketch and OmniGraffle bind it to `xl`.
 */
export function referenceAttributeNames(element: Element): string[] {
  const names: string[] = [];
  for (const attribute of element.attributes) {
    const qualified = attribute.name.toLowerCase();
    if (
      qualified === 'href' ||
      qualified === 'xlink:href' ||
      (attribute.namespaceURI === XLINK_NS &&
        attribute.localName?.toLowerCase() === 'href')
    )
      names.push(attribute.name);
  }
  return names;
}

interface HrefTarget {
  id: string;
  name: string;
}

interface UrlTargets {
  ids: string[];
  name: string;
  value: string;
}

/** The fragment of each `href`, read as a renderer reads it: decoded once. */
function hrefTargets(element: Element): HrefTarget[] {
  const found: HrefTarget[] = [];
  for (const name of referenceAttributeNames(element)) {
    const value = element.getAttribute(name)?.trim() ?? '';
    if (value.startsWith('#') && value.length > 1)
      found.push({ id: fragmentId(value.slice('#'.length)), name });
  }
  return found;
}

/** The local `url()` targets of each presentation attribute that has any. */
function urlAttributeTargets(element: Element): UrlTargets[] {
  const found: UrlTargets[] = [];
  for (const { name, value } of element.attributes) {
    // A `#` can arrive as a CSS escape, so a backslash keeps the value in.
    if (
      !(value.includes('#') || value.includes('\\')) ||
      !isPresentationAttribute(name)
    )
      continue;
    const ids = urlTargets(value)
      .filter((target) => target.startsWith('#') && target.length > 1)
      .map((target) => fragmentId(target.slice('#'.length)));
    if (ids.length > 0) found.push({ ids, name, value });
  }
  return found;
}

type Rewrite = [element: Element, name: string, value: string];

/** The id each renamed id becomes, in the order the definitions come. */
function planRenames(
  defined: ReadonlyMap<string, Element>,
  referenced: ReadonlySet<string>,
  taken: Set<string>
): Map<string, string> {
  const renames = new Map<string, string>();
  let counter = 0;
  for (const id of defined.keys()) {
    if (!referenced.has(id) || PLAIN_ID.test(id)) continue;
    let generated: string;
    do generated = `${GENERATED_PREFIX}${++counter}`;
    while (taken.has(generated));
    taken.add(generated);
    renames.set(id, generated);
  }
  return renames;
}

/** `null` when a reference to a renamed id cannot be restated. */
function planRewrites(
  elements: readonly Element[],
  renames: ReadonlyMap<string, string>
): Rewrite[] | null {
  const rewrites: Rewrite[] = [];
  for (const element of elements) {
    for (const { id, name } of hrefTargets(element)) {
      const renamed = renames.get(id);
      if (renamed !== undefined) rewrites.push([element, name, `#${renamed}`]);
    }
    for (const { ids, name, value } of urlAttributeTargets(element)) {
      if (ids.some((id) => renames.has(id))) {
        const restated = canonicalLocalUrls(value, renames);
        if (restated === null) return null;
        rewrites.push([element, name, restated]);
      }
    }
  }
  return rewrites;
}

/**
 * Renames every id that a local reference names and that is not a `PLAIN_ID`,
 * in the definition and in every reference to it (`href`, and `url()` in any
 * presentation attribute, lists and fallbacks included). Run BEFORE the
 * attribute sweep: a reference whose id spells `url(https://…)` or `alert(` is
 * stripped there as dangerous, and the optimizer then deletes the definition.
 *
 * The new id is none of the ids in the document, and none a reference names,
 * so no reference that dangled starts to resolve. Only an id that is defined and
 * referenced is renamed, and only the first element of a duplicated id, which
 * is the one a renderer resolves.
 *
 * Nothing is renamed when a reference to a renamed id cannot be restated: the
 * sweep and the restatement after it rule on that attribute as they did.
 */
export function renameReferencedIds(doc: Document): void {
  const elements = [...doc.querySelectorAll('*')];

  const defined = new Map<string, Element>();
  const taken = new Set<string>();
  for (const element of elements) {
    const id = element.getAttribute('id');
    if (!id) continue;
    taken.add(id);
    if (!defined.has(id)) defined.set(id, element);
  }

  const referenced = new Set<string>();
  for (const element of elements) {
    for (const { id } of hrefTargets(element)) referenced.add(id);
    for (const { ids } of urlAttributeTargets(element))
      for (const id of ids) referenced.add(id);
  }
  for (const id of referenced) taken.add(id);

  const renames = planRenames(defined, referenced, taken);
  if (renames.size === 0) return;
  const rewrites = planRewrites(elements, renames);
  if (rewrites === null) return;

  for (const [element, name, value] of rewrites)
    element.setAttribute(name, value);
  for (const [id, renamed] of renames)
    defined.get(id)?.setAttribute('id', renamed);
}
