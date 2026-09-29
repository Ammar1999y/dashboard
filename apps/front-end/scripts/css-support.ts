// Checks CSS against the `css` environment of this project's browserslist
// (package.json), resolved at run time, so a change to the list changes what
// passes. The `defaults` environment, which Next compiles JavaScript for and
// autoprefixer prefixes for, adds browsers the CSS is not promised to; the
// check falls back to it only when `css` is removed.
//
// A stylesheet ships as written: an unsupported selector drops its whole rule
// and an unsupported value drops its declaration, silently. Only features
// whose loss renders the page wrong (content hidden or misplaced, sizes,
// spacing, colors) are listed, and any use of one fails the check. Features
// whose loss only drops polish on older browsers (`:focus-visible`,
// `overflow: clip`, `backdrop-filter`, `text-wrap: balance`,
// `content-visibility`) are deliberately not listed. A declaration with a
// fallback before it (`100vh` then `100dvh`) and anything inside `@supports`
// are safe and not reported.
//
// `@layer` in the app's sources is Tailwind's and compiled away; one left in
// built CSS is native, and a browser without layers drops every rule in it.
//
// Support comes from caniuse-lite where it tracks the feature. For the rest,
// the first version listed here (MDN) is compared for Chromium (Chrome, Edge,
// Android WebView), Firefox and Safari; other engines in the list cannot be
// told apart by version and are named as unverified.
//
// `bun scripts/css-support.ts <file.css>…` checks built files; `--app` builds
// the app's own stylesheets through its PostCSS pipeline and checks those.
// scripts/build-editor-css.ts runs the check on the export stylesheet.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import type { ChildNode, Container, Declaration, Rule } from 'postcss';

import browserslist from 'browserslist';
import postcss from 'postcss';

import baseConfig from '../tailwind.config';
import { processCss, ROOT } from './css-pipeline';

const require = createRequire(import.meta.url);

type Family = 'chrome' | 'firefox' | 'safari';

interface Feature {
  name: string;
  /** What the pattern is tested against. */
  on: 'selector' | 'declaration' | 'at-rule';
  pattern: RegExp;
  caniuse?: string;
  since?: Record<Family, number>;
}

const FEATURES: Feature[] = [
  {
    name: ':has()',
    on: 'selector',
    pattern: /:has\(/,
    caniuse: 'css-has',
  },
  {
    name: ':is()',
    on: 'selector',
    pattern: /:is\(/,
    caniuse: 'css-matches-pseudo',
  },
  {
    // Shipped with :is() in every engine; caniuse tracks only :is().
    name: ':where()',
    on: 'selector',
    pattern: /:where\(/,
    caniuse: 'css-matches-pseudo',
  },
  {
    name: ':dir()',
    on: 'selector',
    pattern: /:dir\(/,
    caniuse: 'css-dir-pseudo',
  },
  {
    // Also grid gap, which is older: the rule cannot tell which it styles.
    name: 'gap (flexbox)',
    on: 'declaration',
    pattern: /^(?:row-|column-)?gap:/,
    caniuse: 'flexbox-gap',
  },
  {
    name: 'aspect-ratio',
    on: 'declaration',
    pattern: /^aspect-ratio:/,
    since: { chrome: 88, firefox: 89, safari: 15 },
  },
  {
    name: 'lh / rlh units',
    on: 'declaration',
    pattern: /[\d.]r?lh\b/,
    since: { chrome: 109, firefox: 120, safari: 16.4 },
  },
  {
    name: 'dvh / svh / lvh units',
    on: 'declaration',
    pattern: /[\d.][dsl]v(?:h|w|i|b|min|max)\b/,
    caniuse: 'viewport-unit-variants',
  },
  {
    // `wrap` is the initial value, so only `nowrap` changes anything.
    name: 'text-wrap: nowrap',
    on: 'declaration',
    pattern: /^text-wrap(?:-mode)?:\s*nowrap/,
    since: { chrome: 114, firefox: 121, safari: 17.4 },
  },
  {
    name: 'color-mix()',
    on: 'declaration',
    pattern: /color-mix\(/,
    since: { chrome: 111, firefox: 113, safari: 16.2 },
  },
  {
    name: 'lab() / lch() / oklab() / oklch()',
    on: 'declaration',
    pattern: /\b(?:ok)?(?:lab|lch)\(/,
    caniuse: 'css-lch-lab',
  },
  {
    name: 'min() / max() / clamp()',
    on: 'declaration',
    pattern: /\b(?:min|max|clamp)\(/,
    caniuse: 'css-math-functions',
  },
  {
    name: 'rotate / scale / translate properties',
    on: 'declaration',
    pattern: /^(?:rotate|scale|translate):/,
    since: { chrome: 104, firefox: 72, safari: 14.1 },
  },
  {
    name: 'inset shorthand',
    on: 'declaration',
    pattern: /^inset:/,
    since: { chrome: 87, firefox: 66, safari: 14.1 },
  },
  {
    name: 'logical inset and shorthands',
    on: 'declaration',
    pattern:
      /^(?:inset-(?:inline|block)(?:-start|-end)?|(?:margin|padding|border)-(?:inline|block)):/,
    since: { chrome: 87, firefox: 66, safari: 14.1 },
  },
  {
    name: 'logical border-radius',
    on: 'declaration',
    pattern: /^border-(?:start|end)-(?:start|end)-radius:/,
    since: { chrome: 89, firefox: 66, safari: 15 },
  },
  {
    name: '@container',
    on: 'at-rule',
    pattern: /^container\b/,
    caniuse: 'css-container-queries',
  },
  {
    name: '@layer',
    on: 'at-rule',
    pattern: /^layer\b/,
    caniuse: 'css-cascade-layers',
  },
];

/**
 * Uses of a listed selector feature reviewed as cosmetic and skipped: without
 * them the page is the same, only less polished. Each names its source and why.
 */
const COSMETIC: { feature: string; selector: RegExp; why: string }[] = [
  {
    feature: ':has()',
    selector: /^\.has-\\\[\\>svg\\\]\\:px-/,
    why: 'components/ui/button.tsx: 4px less padding beside an icon',
  },
  {
    feature: ':has()',
    selector: /^\.has-\\\[\\:focus\\\]\\:/,
    why: 'components/ui/calendar.tsx: the date field focus ring',
  },
  {
    feature: ':where()',
    selector: /^abbr:where\(\[title\]\)$/,
    why: 'Tailwind preflight: a dotted underline on abbr[title]',
  },
];

const isCosmetic = (feature: Feature, selector: string) =>
  COSMETIC.some((c) => c.feature === feature.name && c.selector.test(selector));

/** Engines whose versions follow Chrome's, Firefox's or Safari's numbering. */
const FAMILY: Record<string, Family> = {
  chrome: 'chrome',
  edge: 'chrome',
  and_chr: 'chrome',
  android: 'chrome',
  firefox: 'firefox',
  and_ff: 'firefox',
  safari: 'safari',
  ios_saf: 'safari',
};

// Typed `string[]`, but a `BROWSERSLIST` environment override comes back as a string.
const loaded: unknown = browserslist.loadConfig({ path: ROOT, env: 'css' });
export const QUERY: string[] =
  typeof loaded === 'string' ? [loaded] : Array.isArray(loaded) ? loaded : [];
if (QUERY.length === 0) {
  throw new Error(`[css-support] no browserslist in ${ROOT}/package.json`);
}
const TARGETS = browserslist(QUERY).map((target) => {
  const [agent = '', version = ''] = target.split(' ');
  return { target, agent, version, number: Number.parseFloat(version) };
});

type Stats = Record<string, Record<string, string>>;

function caniuseStats(id: string): Stats {
  const lite: unknown = require('caniuse-lite');
  const packed: unknown = require(`caniuse-lite/data/features/${id}`);
  const unpacked =
    typeof lite === 'object' &&
    lite !== null &&
    'feature' in lite &&
    typeof lite.feature === 'function'
      ? (lite.feature as (data: unknown) => unknown)(packed)
      : undefined;
  if (
    typeof unpacked !== 'object' ||
    unpacked === null ||
    !('stats' in unpacked) ||
    typeof unpacked.stats !== 'object' ||
    unpacked.stats === null
  ) {
    throw new TypeError(`[css-support] caniuse-lite has no ${id}`);
  }
  return unpacked.stats as Stats;
}

interface Support {
  /** Targets without the feature; partial or flagged support counts as none. */
  lacking: string[];
  /** Targets a version table cannot judge. */
  unverified: string[];
}

function support(feature: Feature): Support {
  if (feature.caniuse) {
    const stats = caniuseStats(feature.caniuse);
    return {
      lacking: TARGETS.filter(
        ({ agent, version }) => !stats[agent]?.[version]?.startsWith('y')
      ).map((t) => t.target),
      unverified: [],
    };
  }
  const lacking: string[] = [];
  const unverified: string[] = [];
  for (const { agent, number, target } of TARGETS) {
    const family = FAMILY[agent];
    if (!family || !feature.since) unverified.push(target);
    else if (number < feature.since[family]) lacking.push(target);
  }
  return { lacking, unverified };
}

const SUPPORT = new Map(FEATURES.map((f) => [f, support(f)]));

const guarded = (node: ChildNode) => {
  for (let parent: Container | undefined = node.parent; parent;) {
    if (
      parent.type === 'atrule' &&
      'name' in parent &&
      parent.name === 'supports'
    ) {
      return true;
    }
    parent = parent.parent as Container | undefined;
  }
  return false;
};

/**
 * `height: 100vh; height: 100dvh`: a browser that cannot parse the second
 * keeps the first, so the pair is safe. The first may also sit in an earlier
 * top-level rule with the same selector (app-style.css `.h-dvh` under
 * `@media (display-mode: standalone)`). Only the property is compared.
 */
function hasFallback(decl: Declaration) {
  for (let prev = decl.prev(); prev; prev = prev.prev()) {
    if (prev.type === 'decl' && prev.prop === decl.prop) return true;
  }
  const rule = decl.parent;
  if (rule?.type !== 'rule') return false;
  let top: ChildNode = rule as ChildNode;
  while (top.parent && top.parent.type !== 'root') {
    top = top.parent as ChildNode;
  }
  for (let prev = top.prev(); prev; prev = prev.prev()) {
    if (
      prev.type === 'rule' &&
      prev.selector === (rule as Rule).selector &&
      prev.some((n) => n.type === 'decl' && n.prop === decl.prop)
    ) {
      return true;
    }
  }
  return false;
}

export interface Finding {
  feature: string;
  unsupportedIn: string[];
  unverifiedIn: string[];
  samples: string[];
}

const MAX_SAMPLES = 4;

/** Breaking features the CSS uses that some target lacks. */
export function findUnsupported(css: string): Finding[] {
  const hits = new Map<Feature, Set<string>>();
  const record = (feature: Feature, sample: string) => {
    if ((SUPPORT.get(feature)?.lacking.length ?? 0) === 0) return;
    const samples = hits.get(feature) ?? new Set<string>();
    samples.add(sample.length > 120 ? `${sample.slice(0, 117)}…` : sample);
    hits.set(feature, samples);
  };

  postcss.parse(css).walk((node) => {
    if (guarded(node)) return;
    if (node.type === 'rule') {
      for (const f of FEATURES) {
        if (
          f.on === 'selector' &&
          f.pattern.test(node.selector) &&
          !isCosmetic(f, node.selector)
        ) {
          record(f, node.selector);
        }
      }
    } else if (node.type === 'decl') {
      if (node.prop.startsWith('--') || hasFallback(node)) return;
      const declaration = `${node.prop}:${node.value}`;
      for (const f of FEATURES) {
        if (f.on === 'declaration' && f.pattern.test(declaration)) {
          const rule =
            node.parent?.type === 'rule' ? `${node.parent.selector} ` : '';
          record(f, `${rule}{ ${declaration} }`);
        }
      }
    } else if (node.type === 'atrule') {
      const atRule = `${node.name} ${node.params}`;
      for (const f of FEATURES) {
        if (f.on === 'at-rule' && f.pattern.test(atRule))
          record(f, `@${atRule}`);
      }
    }
  });

  return [...hits].map(([feature, samples]) => ({
    feature: feature.name,
    unsupportedIn: SUPPORT.get(feature)?.lacking ?? [],
    unverifiedIn: SUPPORT.get(feature)?.unverified ?? [],
    samples: [...samples],
  }));
}

const list = (targets: string[]) =>
  targets.slice(0, 6).join(', ') + (targets.length > 6 ? ', …' : '');

export function formatFindings(findings: Finding[], label: string) {
  return findings
    .map(
      (f) =>
        `${label}: ERROR ${f.feature} — unsupported in ${list(f.unsupportedIn)}\n` +
        [...f.samples]
          .slice(0, MAX_SAMPLES)
          .map((s) => `    ${s}`)
          .join('\n') +
        (f.samples.length > MAX_SAMPLES
          ? `\n    … ${f.samples.length - MAX_SAMPLES} more`
          : '')
    )
    .join('\n');
}

/** Engines no version table covers, for the features `css` uses. */
export function unverifiedTargets(css: string) {
  const used = FEATURES.filter((f) => f.since && usesFeature(css, f));
  return [...new Set(used.flatMap((f) => SUPPORT.get(f)?.unverified ?? []))];
}

function usesFeature(css: string, feature: Feature) {
  let found = false;
  postcss.parse(css).walk((node) => {
    if (found || guarded(node)) return;
    if (feature.on === 'selector' && node.type === 'rule') {
      found = feature.pattern.test(node.selector);
    } else if (feature.on === 'declaration' && node.type === 'decl') {
      found =
        !hasFallback(node) &&
        feature.pattern.test(`${node.prop}:${node.value}`);
    } else if (feature.on === 'at-rule' && node.type === 'atrule') {
      found = feature.pattern.test(`${node.name} ${node.params}`);
    }
  });
  return found;
}

/** The app's stylesheets, as its PostCSS pipeline builds them for Next. */
async function appStylesheets() {
  const files = [
    ...new Bun.Glob('styles/*.css').scanSync(ROOT),
    ...new Bun.Glob('components/**/*.css').scanSync(ROOT),
  ];
  return Promise.all(
    files.map(async (file) => {
      const from = join(ROOT, file);
      return {
        label: file.replaceAll('\\', '/'),
        css: await processCss(readFileSync(from, 'utf8'), baseConfig, { from }),
      };
    })
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sheets = args.includes('--app')
    ? await appStylesheets()
    : args.map((file) => ({
        label: relative(ROOT, file).replaceAll('\\', '/'),
        css: readFileSync(file, 'utf8'),
      }));

  let errors = 0;
  const unverified = new Set<string>();
  for (const { label, css } of sheets) {
    const findings = findUnsupported(css);
    errors += findings.length;
    if (findings.length > 0) console.log(formatFindings(findings, label));
    for (const target of unverifiedTargets(css)) unverified.add(target);
  }
  if (unverified.size > 0) {
    console.log(
      `[css-support] not verifiable by version for: ${[...unverified].join(', ')}`
    );
  }
  console.log(
    errors > 0
      ? `[css-support] ${errors} breaking feature(s) for: ${QUERY.join(', ')}`
      : `[css-support] ${sheets.length} stylesheet(s) fit: ${QUERY.join(', ')}`
  );
  process.exit(errors > 0 ? 1 : 0);
}
