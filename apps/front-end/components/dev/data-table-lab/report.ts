import type { DomRegion, LabEnvironment, LabEvent } from './types';

import { version as reactVersion } from 'react';

import { isTableComponent } from './component-names';

const REGIONS: DomRegion[] = [
  'header',
  'body',
  'toolbar',
  'table-other',
  'overlay',
];

export const tableRenders = (renders: Record<string, number>) =>
  Object.entries(renders).filter(([name]) => isTableComponent(name));

const total = (entries: [string, number][]) =>
  entries.reduce((sum, [, count]) => sum + count, 0);

const counts = (entries: [string, number][], limit = 14) =>
  entries.length === 0
    ? '—'
    : entries
        .slice(0, limit)
        .map(([name, count]) => `${name}×${count}`)
        .join(', ') + (entries.length > limit ? ', …' : '');

export const mutationSummary = (event: LabEvent) =>
  REGIONS.map((region) => `${region} ${event.mutations[region] ?? 0}`).join(
    ' · '
  );

const escapeCell = (text: string) => text.replaceAll('|', String.raw`\|`);

const strictModeText = (env: LabEnvironment) => {
  if (env.strictMode === null) return 'unknown';
  if (!env.strictMode) return 'off';
  // The mode flag survives into production builds; the double render and
  // effect replay it stands for do not.
  return env.reactBuild === 'production' ? 'on (inactive in production)' : 'on';
};

export const describeEnvironment = (env: LabEnvironment | null) =>
  env
    ? [
        `NODE_ENV ${env.nodeEnv}`,
        `React build ${env.reactBuild}`,
        `StrictMode ${strictModeText(env)}`,
        env.timing === 'profiler'
          ? 'renders counted per commit (Profiler)'
          : 'renders counted per animation frame (no Profiler callbacks: plain production build or ?probe=frames)',
        ...(env.namesMinified
          ? [
              'WARNING: component names are minified, so unnamed components (…Inner) are missing from every count — rebuild with --no-mangling',
            ]
          : []),
      ].join(' · ')
    : 'not attached';

export const compiledSummary = (env: LabEnvironment | null) => {
  const entries = Object.entries(env?.compiled ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return {
    compiled: entries.filter(([, yes]) => yes).map(([name]) => name),
    plain: entries.filter(([, yes]) => !yes).map(([name]) => name),
  };
};

export function buildReport(
  events: LabEvent[],
  env: LabEnvironment | null
): string {
  const reported = events.filter(
    (e) => e.kind !== 'passive' || e.mismatches.length > 0
  );
  const failed = reported.filter((e) => e.mismatches.length > 0);
  const { compiled, plain } = compiledSummary(env);
  const lines = [
    '# Data-table lab report',
    '',
    `- ${new Date().toISOString()} · React ${reactVersion} · ${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
    `- ${navigator.userAgent}`,
    `- ${describeEnvironment(env)}`,
    `- ${reported.length} events, ${failed.length} with mismatches`,
    '',
    '## React Compiler output in this build',
    '',
    `- compiled: ${compiled.join(', ') || '—'}`,
    `- not compiled: ${plain.join(', ') || '—'}`,
    '',
    '## Summary',
    '',
    '| # | kind | event | result | commits | table renders | DOM mutations (h/b/t/o/ov) | render ms | max frame ms | frames >50ms |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...reported.map((e) => {
      const dom = REGIONS.map((r) => e.mutations[r] ?? 0).join('/');
      const result =
        e.mismatches.length === 0 ? 'ok' : `FAIL ${e.mismatches.length}`;
      return `| ${e.id} | ${e.kind} | ${escapeCell(e.label)} | ${result} | ${e.commits} | ${total(tableRenders(e.renders))} | ${dom} | ${e.renderMs ?? 'n/a'} | ${e.maxFrameMs} | ${e.longFrames} |`;
    }),
    '',
    '## Mismatches',
    '',
    ...(failed.length === 0
      ? ['none']
      : failed.flatMap((e) => [
          `### #${e.id} ${e.label}`,
          ...e.mismatches.map((m) => `- **${m.check}**: ${m.detail}`),
          '',
        ])),
    '',
    '## Per event: store writes → renders → notes',
    '',
    ...reported.flatMap((e) => [
      `- **#${e.id} ${e.label}**`,
      `  - store writes: ${counts(Object.entries(e.stores), 20)}`,
      `  - rendered: ${counts(tableRenders(e.renders))}`,
      `  - mounted: ${counts(tableRenders(e.mounts))}`,
      `  - unmounted: ${counts(tableRenders(e.unmounts))}`,
      ...e.notes.map((n) => `  - ${n}`),
    ]),
    '',
  ];
  return lines.join('\n');
}
