/**
 * Local Tailwind conventions, enforced so the written rule and the code cannot
 * drift apart.
 *
 * Scope is deliberately narrow: only the things that are mechanically always
 * wrong here. Arbitrary values built from `calc()`, CSS custom properties
 * (safe-area insets, Radix positioning vars) or viewport units are legitimate
 * and are not reported.
 *
 * The split between the two direction buckets is a browser-support decision,
 * not a style one. Logical *longhands* — `margin-inline-start/end`,
 * `padding-inline-start/end`, `border-inline-start/end` and their scroll
 * equivalents — are safe on this project's browserslist. The logical
 * *shorthands* (`margin-inline`, `padding-inline`, `border-inline`), the
 * logical inset (`inset-inline-start/end`, i.e. `start-*` / `end-*`) and the
 * logical border-radius longhands (`rounded-s` / `rounded-e`) are not, so
 * anything that compiles to those must be written as a physical class behind an
 * `rtl:` / `ltr:` pair instead.
 */

const CLASS_CALLEES = new Set(['cn', 'clsx', 'cva', 'twMerge', 'classNames']);

/**
 * The app renders under `dir='rtl'`, so the inline-start edge is the RIGHT one:
 * a class written as `right-4` means start, not end. Replacing it the other way
 * round mirrors the layout.
 *
 * Every replacement here compiles to a safe logical longhand.
 */
const LOGICAL = new Map([
  ['mr', 'ms'],
  ['ml', 'me'],
  ['pr', 'ps'],
  ['pl', 'pe'],
  ['scroll-mr', 'scroll-ms'],
  ['scroll-ml', 'scroll-me'],
  ['scroll-pr', 'scroll-ps'],
  ['scroll-pl', 'scroll-pe'],
  ['border-r', 'border-s'],
  ['border-l', 'border-e'],
  // `text-align: start|end` is a logical *value*, not a logical property, and
  // predates the whole feature — it is safe everywhere.
  ['text-right', 'text-start'],
  ['text-left', 'text-end'],
]);

/** Physical, and with no logical form that is safe here. Needs the pair. */
const NEEDS_VARIANT = new Map([
  ['right', 'left'],
  ['left', 'right'],
  ['rounded-r', 'rounded-l'],
  ['rounded-l', 'rounded-r'],
]);

/**
 * Logical utilities that are banned outright: their CSS is not supported well
 * enough on this browserslist. Under `dir='rtl'`, start === right.
 */
const BANNED_LOGICAL = new Map([
  ['start', ['right', 'left']],
  ['end', ['left', 'right']],
  ['rounded-s', ['rounded-r', 'rounded-l']],
  ['rounded-e', ['rounded-l', 'rounded-r']],
]);

/**
 * `ltr:` / `rtl:` state a direction on purpose, and a placeholder must not
 * follow an input's `dir='auto'` — which resolves from the value, not from the
 * placeholder text. Both are deliberate physical positioning.
 */
const DELIBERATE_VARIANTS = new Set(['ltr', 'rtl', 'placeholder']);

// eslint-disable-next-line security/detect-unsafe-regex -- bounded: one optional fractional group, no nesting
const LITERAL_FONT_SIZE = /^text-\[\d+(\.\d+)?(px|rem|em)]$/;

/**
 * Splits a class into its variants and the utility they qualify, ignoring the
 * `:` inside an arbitrary value such as `data-[state=open]:`.
 */
function splitVariants(token) {
  const variants = [];
  let depth = 0;
  let start = 0;
  for (const [i, c] of [...token].entries()) {
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ':' && depth === 0) {
      variants.push(token.slice(start, i));
      start = i + 1;
    }
  }
  return { variants, utility: token.slice(start).replace(/^!/, '') };
}

function isClassString(node, sourceCode) {
  for (const ancestor of sourceCode.getAncestors(node)) {
    if (
      (ancestor.type === 'JSXAttribute' &&
        ancestor.name?.type === 'JSXIdentifier' &&
        (ancestor.name.name === 'className' ||
          ancestor.name.name === 'class')) ||
      (ancestor.type === 'CallExpression' &&
        ancestor.callee.type === 'Identifier' &&
        CLASS_CALLEES.has(ancestor.callee.name))
    ) {
      return true;
    }
  }
  return false;
}

/** `rounded-s` must not match `rounded-sm`, so only an exact hit or a `-` run-on. */
function lookup(map, bare) {
  for (const [prefix, replacement] of map) {
    if (bare === prefix || bare.startsWith(prefix + '-')) {
      return { prefix, replacement };
    }
  }
  return null;
}

/** `-right-2` + (right -> left) => `-left-2`, so the message is copy-pasteable. */
function swapPrefix(raw, from, to) {
  const negative = raw.startsWith('-');
  const bare = negative ? raw.slice(1) : raw;
  return (negative ? '-' : '') + to + bare.slice(from.length);
}

function checkClassString(context, node, value) {
  for (const raw of value.split(/\s+/)) {
    if (!raw) continue;
    const { variants, utility } = splitVariants(raw);
    const bare = utility.startsWith('-') ? utility.slice(1) : utility;

    const banned = lookup(BANNED_LOGICAL, bare);
    if (banned) {
      const [rtlSide, ltrSide] = banned.replacement;
      context.report({
        node,
        messageId: 'bannedLogical',
        data: {
          utility: raw,
          rtl: swapPrefix(raw, banned.prefix, rtlSide),
          ltr: swapPrefix(raw, banned.prefix, ltrSide),
        },
      });
    } else if (!variants.some((v) => DELIBERATE_VARIANTS.has(v))) {
      const logical = lookup(LOGICAL, bare);
      const needsVariant = logical ? null : lookup(NEEDS_VARIANT, bare);
      if (logical) {
        context.report({
          node,
          messageId: 'physical',
          data: {
            utility: raw,
            logical: swapPrefix(raw, logical.prefix, logical.replacement),
          },
        });
      } else if (needsVariant) {
        context.report({
          node,
          messageId: 'needsVariant',
          data: {
            utility: raw,
            mirrored: swapPrefix(
              raw,
              needsVariant.prefix,
              needsVariant.replacement
            ),
          },
        });
      }
    }

    if (LITERAL_FONT_SIZE.test(bare)) {
      context.report({ node, messageId: 'fontSize', data: { utility: raw } });
    }
  }
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Tailwind classes use the logical utilities that are safe on this browserslist, and named font sizes.',
    },
    schema: [],
    messages: {
      physical:
        '"{{utility}}" is a physical direction and this app is RTL. Use "{{logical}}", which resolves to the same edge here and mirrors correctly.',
      needsVariant:
        '"{{utility}}" is a physical direction and this app is RTL. Its logical form is not supported across this browserslist, so write the pair instead: `rtl:{{utility}} ltr:{{mirrored}}`.',
      bannedLogical:
        '"{{utility}}" compiles to logical inset / logical border-radius, which is not supported across this browserslist. Write the physical pair instead: `rtl:{{rtl}} ltr:{{ltr}}`.',
      fontSize:
        '"{{utility}}" hard-codes a font size and opts out of --font-scale. Use a scale token (text-3xs … text-3xl); add a step to tailwind.config.ts if the scale is missing one.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      Literal(node) {
        if (typeof node.value !== 'string' || !isClassString(node, sourceCode))
          return;
        checkClassString(context, node, node.value);
      },
      TemplateElement(node) {
        if (!isClassString(node, sourceCode)) return;
        checkClassString(context, node, node.value.raw);
      },
    };
  },
};

const plugin = { rules: { 'class-conventions': rule } };

export default plugin;
