/**
 * Local Tailwind conventions, enforced so the written rule and the code cannot
 * drift apart.
 *
 * Arbitrary values built from `calc()`, CSS custom properties
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
 *
 * Fixed colors are advisory, including in tone maps outside `className`.
 * Direction, font sizes and Arabic letter-spacing remain mandatory.
 */

import Color from 'colorjs.io';

export const FIXED_COLOR_RULE = 'tailwind/fixed-colors';

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
  ['rounded-tr', 'rounded-tl'],
  ['rounded-tl', 'rounded-tr'],
  ['rounded-br', 'rounded-bl'],
  ['rounded-bl', 'rounded-br'],
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
  ['rounded-ss', ['rounded-tr', 'rounded-tl']],
  ['rounded-se', ['rounded-tl', 'rounded-tr']],
  ['rounded-es', ['rounded-br', 'rounded-bl']],
  ['rounded-ee', ['rounded-bl', 'rounded-br']],
]);

/**
 * `ltr:` / `rtl:` state a direction on purpose, and a placeholder must not
 * follow an input's `dir='auto'` — which resolves from the value, not from the
 * placeholder text. Both are deliberate physical positioning.
 */
const DELIBERATE_VARIANTS = new Set(['ltr', 'rtl', 'placeholder']);

const TARGET_VARIANTS = new Set([
  '*',
  'before',
  'after',
  'first-letter',
  'first-line',
  'marker',
  'selection',
  'file',
  'placeholder',
  'backdrop',
]);

/**
 * A fixed palette step ignores the theme, so the contrast test never sees it.
 * `gray-*` here is the app's own scale, which no theme or mode changes either.
 */
const COLOR_UTILITY =
  /^(?:text|bg|border(?:-[xytrblse])?|ring(?:-offset)?|fill|stroke|from|to|via|outline|divide(?:-[xy])?|placeholder|decoration|shadow|caret|accent)-(.+)$/;
const PALETTE =
  /^(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+$/;
/** Fills whose ink the theme picks by contrast (`scripts/lib/theme-contrast.ts`). */
const THEMED_FILL = /^bg-(primary|destructive)(?:-light|-dark|-hover)?$/;
const COLOR_FAMILIES = new Set([
  'primary',
  'secondary',
  'muted',
  'accent',
  'destructive',
  'success',
  'warning',
  'error',
  'info',
  'background',
  'foreground',
  'card',
  'popover',
  'transparent',
  'white',
  'black',
]);
/**
 * Positive letter-spacing breaks the joins of Arabic script (WebKit bug 195745)
 * and every step here is relative to a positive `--tracking-normal`.
 */
const TRACKING = /^tracking-/;

/** With or without a leading digit, and with or without a `/leading` modifier. */
const LITERAL_FONT_SIZE =
  // eslint-disable-next-line security/detect-unsafe-regex
  /^text-\[(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)](?:\/\S+)?$/;

/**
 * Splits a class into its variants and the utility they qualify, ignoring the
 * `:` inside an arbitrary value such as `data-[state=open]:`.
 */
function splitVariants(token) {
  const variants = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ':' && depth === 0) {
      variants.push(token.slice(start, i));
      start = i + 1;
    }
  }
  const rawUtility = token.slice(start);
  const important = rawUtility.startsWith('!');
  const utility = important ? rawUtility.slice(1) : rawUtility;
  const prefix = token.slice(0, start) + (important ? '!' : '');
  return { variants, prefix, utility, important };
}

function withoutOpacity(utility) {
  let depth = 0;
  for (let i = 0; i < utility.length; i++) {
    if (utility[i] === '[') depth++;
    else if (utility[i] === ']') depth--;
    else if (depth === 0 && utility[i] === '/') return utility.slice(0, i);
  }
  return utility;
}

function fixedColor(utility) {
  const value = COLOR_UTILITY.exec(withoutOpacity(utility))?.[1];
  if (!value) return null;
  if (PALETTE.test(value)) return 'palette';
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const literal = value
    .slice(1, -1)
    .replace(/^color:/, '')
    .replaceAll('_', ' ');
  try {
    new Color(literal);
    return 'arbitraryColor';
  } catch {
    return null;
  }
}

function isColorUtility(utility, prefix) {
  if (!utility.startsWith(`${prefix}-`)) return false;
  const value = utility.slice(prefix.length + 1);
  return (
    COLOR_FAMILIES.has(value.split('-', 1)[0]) ||
    fixedColor(utility) !== null ||
    value.startsWith('[var(') ||
    value.startsWith('[color:')
  );
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

function initializer(node, sourceCode) {
  let scope = sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable)
      return variable.defs.find(
        (definition) => definition.parent?.kind === 'const'
      )?.node.init;
    scope = scope.upper;
  }
}

function unwrap(node) {
  while (
    node &&
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'JSXExpressionContainer',
    ].includes(node.type)
  )
    node = node.expression;
  return node;
}

function staticText(node, sourceCode, seen = new Set()) {
  seen = new Set(seen);
  node = unwrap(node);
  while (node?.type === 'Identifier' && !seen.has(node)) {
    seen.add(node);
    node = unwrap(initializer(node, sourceCode));
  }
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (node.type === 'Literal' && typeof node.value === 'string')
    return node.value;
  if (node.type === 'TemplateLiteral') {
    let text = node.quasis[0].value.cooked;
    for (let i = 0; i < node.expressions.length; i++) {
      const value = staticText(node.expressions[i], sourceCode, seen);
      if (value === null) return null;
      text += value + node.quasis[i + 1].value.cooked;
    }
    return text;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticText(node.left, sourceCode, seen);
    const right = staticText(node.right, sourceCode, seen);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function onLtrElement(node, sourceCode) {
  const ancestors = sourceCode.getAncestors(node);
  const openings = ancestors
    .toReversed()
    .flatMap((ancestor) =>
      ancestor.type === 'JSXOpeningElement'
        ? [ancestor]
        : ancestor.type === 'JSXElement'
          ? [ancestor.openingElement]
          : []
    );
  for (const element of openings) {
    const direction = element.attributes.find(
      (attribute) =>
        attribute.type === 'JSXAttribute' && attribute.name.name === 'dir'
    );
    if (direction) return staticText(direction.value, sourceCode) === 'ltr';
  }
  return false;
}

const emptyClasses = () => ({ base: [], alternatives: [] });
const classGroups = ({ base, alternatives }) => [base, ...alternatives];

// Optional branches are checked against the common classes, never against
// another alternative: flattening them would combine mutually exclusive styles.
function combineClasses(parts) {
  const base = parts.flatMap((part) => part.base);
  return {
    base,
    alternatives: parts.flatMap((part) =>
      part.alternatives.map((alternative) => [...base, ...alternative])
    ),
  };
}

function isClassCall(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    CLASS_CALLEES.has(node.callee.name)
  );
}

function collectClasses(node, sourceCode, seen = new Set()) {
  node = unwrap(node);
  if (!node || seen.has(node)) return emptyClasses();
  seen = new Set(seen).add(node);
  const text = staticText(node, sourceCode);
  if (text !== null) return { base: [{ node, value: text }], alternatives: [] };
  const collect = (value) => collectClasses(value, sourceCode, seen);
  if (node.type === 'Identifier') return collect(initializer(node, sourceCode));
  if (node.type === 'TemplateLiteral')
    return {
      base: node.quasis.map((quasi) => ({
        node: quasi,
        value: quasi.value.cooked ?? quasi.value.raw,
      })),
      alternatives: [],
    };
  if (node.type === 'ConditionalExpression')
    return {
      base: [],
      alternatives: [node.consequent, node.alternate].flatMap((branch) =>
        classGroups(collect(branch))
      ),
    };
  if (node.type === 'LogicalExpression')
    return { base: [], alternatives: classGroups(collect(node.right)) };
  if (node.type === 'ArrayExpression')
    return combineClasses(node.elements.map(collect));
  if (node.type === 'SpreadElement') return collect(node.argument);
  if (node.type === 'MemberExpression') {
    const object = unwrap(
      node.object.type === 'Identifier'
        ? initializer(node.object, sourceCode)
        : node.object
    );
    if (object?.type !== 'ObjectExpression') return emptyClasses();
    const key = node.computed
      ? staticText(node.property, sourceCode)
      : node.property.name;
    const values = object.properties.filter(
      (property) =>
        property.type === 'Property' &&
        (key === null || (property.key.name ?? property.key.value) === key)
    );
    return {
      base: [],
      alternatives: values.flatMap((property) =>
        classGroups(collect(property.value))
      ),
    };
  }
  if (isClassCall(node)) {
    if (node.callee.name !== 'cva')
      return combineClasses(node.arguments.map(collect));
    const base = collect(node.arguments[0]);
    const variants = node.arguments[1]?.properties?.find(
      (property) => (property.key?.name ?? property.key?.value) === 'variants'
    )?.value;
    const choices =
      variants?.properties?.flatMap(
        (variant) =>
          variant.value?.properties?.flatMap((option) =>
            classGroups(collect(option.value))
          ) ?? []
      ) ?? [];
    return {
      base: base.base,
      alternatives: [
        ...base.alternatives,
        ...choices.map((choice) => [...base.base, ...choice]),
      ],
    };
  }
  if (node.type === 'ObjectExpression') {
    const parts = node.properties
      .filter((property) => property.type === 'Property')
      .map((property) => {
        const value = property.computed
          ? staticText(property.key, sourceCode)
          : (property.key.name ?? property.key.value);
        if (typeof value !== 'string' || property.value.value === false)
          return emptyClasses();
        const classes = [{ node: property.key, value }];
        return property.value.value === true
          ? { base: classes, alternatives: [] }
          : { base: [], alternatives: [classes] };
      });
    return combineClasses(parts);
  }
  return emptyClasses();
}

function tokensOf(fragments) {
  return [...new Set(fragments)].flatMap(({ node, value }) =>
    value
      .split(/\s+/)
      .filter(Boolean)
      .map((raw) => {
        const parts = splitVariants(raw);
        return { node, raw, ...parts, color: withoutOpacity(parts.utility) };
      })
  );
}

function targetsOtherElement(variant) {
  if (TARGET_VARIANTS.has(variant)) return true;
  if (!variant.startsWith('[') || variant.startsWith('[@')) return false;
  let depth = 0;
  let other = false;
  for (let index = 1; index < variant.length - 1; index++) {
    const char = variant[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '[' || char === '(') depth++;
    else if (char === ']' || char === ')') depth--;
    else if (depth === 0) {
      if (char === '&') other = false;
      else if (
        '_ >+~'.includes(char) ||
        (char === ':' && variant[index + 1] === ':')
      )
        other = true;
    }
  }
  return other;
}

const targetOf = (variants) => variants.filter(targetsOtherElement).join(':');

function applies(token, variants) {
  return (
    targetOf(token.variants) === targetOf(variants) &&
    token.variants.every((variant) => variants.includes(variant))
  );
}

function effective(tokens, variants) {
  return tokens
    .filter((token) => applies(token, variants))
    .toReversed()
    .toSorted(
      (a, b) =>
        Number(b.important) - Number(a.important) ||
        b.variants.length - a.variants.length
    )[0];
}

function checkWhiteOnFill(fragments, report) {
  const tokens = tokensOf(fragments);
  const backgrounds = tokens.filter((token) =>
    isColorUtility(token.color, 'bg')
  );
  const inks = tokens.filter((token) => isColorUtility(token.color, 'text'));
  const whites = inks.filter((token) => token.color === 'text-white');
  const fills = backgrounds.filter(
    (token) =>
      THEMED_FILL.test(token.color) &&
      (token.utility === token.color || token.utility === `${token.color}/100`)
  );
  const checkPair = (white, fill) => {
    if (!applies(white, fill.variants) && !applies(fill, white.variants))
      return;
    const variants =
      white.variants.length > fill.variants.length
        ? white.variants
        : fill.variants;
    if (
      effective(backgrounds, variants) !== fill ||
      effective(inks, variants)?.color !== 'text-white'
    )
      return;
    const prefix = variants.length > 0 ? `${variants.join(':')}:` : '';
    const family = THEMED_FILL.exec(fill.color)?.[1];
    report(white.node, 'whiteOnFill', {
      utility: white.raw,
      fill: fill.raw,
      ink: `${prefix}${white.important ? '!' : ''}text-${family}-foreground`,
    });
  };
  for (const white of whites) for (const fill of fills) checkPair(white, fill);
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
function swapPrefix(prefix, utility, from, to) {
  const negative = utility.startsWith('-');
  const bare = negative ? utility.slice(1) : utility;
  return prefix + (negative ? '-' : '') + to + bare.slice(from.length);
}

function checkClassString(context, node, value) {
  for (const raw of value.split(/\s+/)) {
    if (!raw) continue;
    const { variants, prefix, utility } = splitVariants(raw);
    const bare = utility.startsWith('-') ? utility.slice(1) : utility;

    const banned = lookup(BANNED_LOGICAL, bare);
    if (banned) {
      const [rtlSide, ltrSide] = banned.replacement;
      context.report({
        node,
        messageId: 'bannedLogical',
        data: {
          utility: raw,
          rtl: swapPrefix(prefix, utility, banned.prefix, rtlSide),
          ltr: swapPrefix(prefix, utility, banned.prefix, ltrSide),
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
            logical: swapPrefix(
              prefix,
              utility,
              logical.prefix,
              logical.replacement
            ),
          },
        });
      } else if (needsVariant) {
        context.report({
          node,
          messageId: 'needsVariant',
          data: {
            utility: raw,
            mirrored: swapPrefix(
              prefix,
              utility,
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

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Tailwind classes use browser-safe logical utilities, named font sizes, readable foregrounds, and no letter-spacing on Arabic text.',
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
      whiteOnFill:
        '"{{utility}}" on "{{fill}}" can vanish: a theme picks the ink that reads on its own fill. Use "{{ink}}".',
      tracking:
        '"{{utility}}" adds letter-spacing, which breaks the joins of Arabic script. Keep it to content that is only Latin or digits: under `ltr:`, or on an element with `dir="ltr"`.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const attributes = [];
    const calls = [];
    const reported = new Set();
    const report = (node, messageId, data) => {
      const key = `${node.range[0]}:${messageId}:${JSON.stringify(data)}`;
      if (reported.has(key)) return;
      reported.add(key);
      context.report({ node, messageId, data });
    };
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (isClassString(node, sourceCode))
          checkClassString(context, node, node.value);
      },
      TemplateElement(node) {
        if (isClassString(node, sourceCode))
          checkClassString(context, node, node.value.raw);
      },
      JSXAttribute(node) {
        if (['className', 'class'].includes(node.name.name))
          attributes.push(node);
      },
      CallExpression(node) {
        if (isClassCall(node) && !isClassString(node, sourceCode))
          calls.push(node);
      },
      'Program:exit'() {
        const handled = new Set();
        const checkTracking = (token, root, inAttribute) => {
          if (!inAttribute && handled.has(token.node)) return;
          if (inAttribute) handled.add(token.node);
          if (
            TRACKING.test(token.utility) &&
            !token.variants.includes('ltr') &&
            !onLtrElement(root, sourceCode)
          )
            report(token.node, 'tracking', { utility: token.raw });
        };
        const check = (root, classes, inAttribute) => {
          for (const group of classGroups(classes)) {
            checkWhiteOnFill(group, report);
            for (const token of tokensOf(group))
              checkTracking(token, root, inAttribute);
          }
        };
        for (const attribute of attributes)
          check(attribute, collectClasses(attribute.value, sourceCode), true);
        for (const call of calls)
          check(call, collectClasses(call, sourceCode), false);
      },
    };
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const fixedColors = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prefer theme colors, with documented exceptions for intentionally fixed colors.',
    },
    schema: [],
    messages: {
      palette:
        '"{{utility}}" uses a fixed palette color. Prefer a semantic theme token when appropriate here. If the fixed color is intentional at this location, suppress this line with `eslint-disable-next-line tailwind/fixed-colors -- reason`.',
      arbitraryColor:
        '"{{utility}}" hard-codes a color. Prefer a semantic theme token when appropriate here. If the fixed color is intentional at this location, suppress this line with `eslint-disable-next-line tailwind/fixed-colors -- reason`.',
    },
  },
  create(context) {
    const check = (node, value) => {
      const tokens = value.split(/\s+/).filter(Boolean);
      for (const raw of tokens) {
        const messageId = fixedColor(splitVariants(raw).utility);
        if (messageId)
          context.report({ node, messageId, data: { utility: raw } });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

const plugin = {
  rules: { 'class-conventions': rule, 'fixed-colors': fixedColors },
};

export default plugin;
