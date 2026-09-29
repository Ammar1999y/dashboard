// The app's PostCSS pipeline, runnable outside Next: the plugins listed in
// postcss.config.js, in order, with Tailwind given a caller's config.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AcceptedPlugin } from 'postcss';
import type { Config } from 'tailwindcss';

import postcss from 'postcss';
import tailwind from 'tailwindcss';

const require = createRequire(import.meta.url);
export const ROOT = join(import.meta.dirname, '..');

type PluginEntry = string | [string, unknown];

const isPluginEntry = (entry: unknown): entry is PluginEntry =>
  typeof entry === 'string' ||
  (Array.isArray(entry) && typeof entry[0] === 'string');

const isPostcssPlugin = (value: unknown): value is AcceptedPlugin =>
  typeof value === 'function' ||
  (typeof value === 'object' && value !== null && 'postcssPlugin' in value);

function loadPlugins(config: Config): AcceptedPlugin[] {
  const loaded: unknown = require(join(ROOT, 'postcss.config.js'));
  const entries =
    typeof loaded === 'object' && loaded !== null && 'plugins' in loaded
      ? loaded.plugins
      : undefined;
  if (!Array.isArray(entries) || !entries.every(isPluginEntry)) {
    throw new TypeError(
      '[css] postcss.config.js must list plugins as names or [name, options]'
    );
  }
  return entries.map((entry) => {
    const [name, options] = typeof entry === 'string' ? [entry] : entry;
    if (name === 'tailwindcss') return tailwind(config);
    const plugin: unknown = require(name);
    const factory =
      typeof plugin === 'object' && plugin !== null && 'default' in plugin
        ? plugin.default
        : plugin;
    const created: unknown =
      typeof factory === 'function' ? factory(options) : undefined;
    if (!isPostcssPlugin(created)) {
      throw new TypeError(`[css] ${name} is not a PostCSS plugin`);
    }
    return created;
  });
}

export async function processCss(
  css: string,
  config: Config,
  { from }: { from: string }
) {
  const result = await postcss(loadPlugins(config)).process(css, { from });
  return result.css;
}
