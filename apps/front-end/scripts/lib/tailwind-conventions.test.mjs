import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Linter } from 'eslint';

import plugin, {
  FIXED_COLOR_RULE,
} from '../../eslint-rules/tailwind-conventions.mjs';
import { blocksLint } from '../lint.mjs';

const config = [
  {
    files: ['**/*.jsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { tailwind: plugin },
    rules: {
      'tailwind/class-conventions': 'error',
      [FIXED_COLOR_RULE]: 'warn',
    },
  },
];

const lint = (code) =>
  new Linter().verify(code, config, { filename: 'probe.jsx' });
const errors = (code) => lint(code).filter((message) => message.severity === 2);

describe('fixed colors are actionable, non-blocking warnings', () => {
  test.each([
    'text-red-500',
    'bg-[#ff0000]',
    'bg-[rgb(255,0,0)]',
    'bg-[hsl(0_100%_50%)]',
    'text-[oklch(0.6_0.2_30)]',
    'caret-red-500',
    'ring-offset-blue-500',
    'accent-green-500',
    'dark:hover:!text-red-500/80',
    'bg-[rgb(255_0_0/50%)]/80',
  ])('%s', (utility) => {
    const messages = lint(`const view = <div className="${utility}" />;`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      ruleId: FIXED_COLOR_RULE,
      severity: 1,
    });
    expect(messages[0]?.message).toContain(
      'eslint-disable-next-line tailwind/fixed-colors -- reason'
    );
    expect(messages.some(blocksLint)).toBe(false);
  });

  test('tone maps are covered outside className', () => {
    expect(lint("const tones = { pdf: 'text-red-500' };")).toHaveLength(1);
  });

  test('a documented exception suppresses only the color warning', () => {
    const messages = lint(`const view = <div
      // eslint-disable-next-line tailwind/fixed-colors -- fixed brand color
      className="bg-[#ff0000] tracking-wide"
    />;`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ severity: 2, messageId: 'tracking' });
  });

  test.each([
    'bg-primary text-primary-foreground',
    'bg-[var(--brand)]',
    'bg-[url(/image.png)]',
    'border-[length:var(--width)]',
  ])('allows %s', (classes) => {
    expect(lint(`const view = <div className="${classes}" />;`)).toEqual([]);
  });
});

describe('the foreground recommendation follows the active background', () => {
  test.each([
    ['<div className="bg-primary text-white" />', 'text-primary-foreground'],
    [
      '<div className="bg-black text-white hover:bg-primary" />',
      'hover:text-primary-foreground',
    ],
    [
      '<div className="bg-primary hover:text-white" />',
      'hover:text-primary-foreground',
    ],
    ['<div className="bg-primary !text-white" />', '!text-primary-foreground'],
    [
      "<div className={cn('bg-primary', 'text-white')} />",
      'text-primary-foreground',
    ],
    [
      "<div className={cn(['bg-primary', 'text-white'])} />",
      'text-primary-foreground',
    ],
    [
      "<div className={cn('bg-primary', active && 'text-white')} />",
      'text-primary-foreground',
    ],
    [
      "<div className={cn('text-white', { 'bg-primary': active })} />",
      'text-primary-foreground',
    ],
    [
      '<div className="bg-black text-white dark:hover:bg-primary" />',
      'dark:hover:text-primary-foreground',
    ],
    [
      '<div className="bg-black text-white [&:hover]:bg-primary" />',
      '[&:hover]:text-primary-foreground',
    ],
    [
      '<div className="bg-black text-white [a&]:hover:bg-primary" />',
      '[a&]:hover:text-primary-foreground',
    ],
    [
      '<div className="!bg-black !text-black before:bg-primary before:text-white" />',
      'before:text-primary-foreground',
    ],
    [
      '<div className="[&>span]:bg-primary [&>span]:text-white" />',
      '[&>span]:text-primary-foreground',
    ],
    [
      "cva('text-white', { variants: { tone: { primary: 'bg-primary', quiet: 'bg-black' } } })",
      'text-primary-foreground',
    ],
  ])('%s', (expression, replacement) => {
    const messages = errors(`const view = ${expression};`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ messageId: 'whiteOnFill' });
    expect(messages[0]?.message).toContain(`Use "${replacement}"`);
  });

  test.each([
    '<div className="bg-black text-white hover:bg-primary hover:text-primary-foreground" />',
    '<div className="bg-primary hover:bg-black hover:text-white" />',
    '<div className="bg-primary hover:bg-[var(--hover)] hover:text-white" />',
    '<div className="bg-primary/10 text-white" />',
    '<div className="bg-black text-white after:bg-primary after:content-[\'\']" />',
    '<div className="bg-black text-white hover:before:bg-primary" />',
    '<div className="bg-black text-white [&>span]:bg-primary" />',
    '<div className="bg-black text-white [&_span]:bg-primary" />',
    '<div className="bg-black text-white [&::after]:bg-primary" />',
    '<div className="bg-black text-white *:bg-primary" />',
    '<input className="bg-black text-white placeholder:bg-primary" />',
    '<input className="bg-black text-white file:bg-primary" />',
    '<div className="before:text-white after:bg-primary" />',
    "<div className={cn(active ? 'bg-primary' : 'text-white')} />",
    "<div className={cn('bg-primary', 'text-white', 'text-primary-foreground')} />",
    "cva('', { variants: { tone: { primary: 'bg-primary text-primary-foreground', quiet: 'bg-black text-white' } } })",
    "cva('', { variants: { ...otherVariants, tone: { primary: 'bg-primary text-primary-foreground' } } })",
  ])('does not combine unrelated states: %s', (expression) => {
    expect(errors(`const view = ${expression};`)).toEqual([]);
  });
});

describe('tracking is checked in classes and respects the nearest direction', () => {
  test.each([
    "const field = 'tracking-number';",
    '<input name="tracking-number" />;',
    '<div dir="ltr" className="tracking-wide" />;',
    "<div dir={'ltr'} className='tracking-wide' />;",
    '<div dir="ltr"><span className="tracking-wide">ABC</span></div>;',
    '<div className="ltr:tracking-wide" />;',
    "const classes = 'tracking-wide'; const view = <div dir='ltr' className={classes} />;",
    "const classes = cn('tracking-wide'); const view = <div dir='ltr' className={classes} />;",
    "const direction = 'ltr'; const view = <div dir={direction} className='tracking-wide' />;",
  ])('allows %s', (code) => expect(lint(code)).toEqual([]));

  test.each([
    '<div className="tracking-wide" />;',
    '<div dir="ltr"><span dir="rtl" className="tracking-wide">عربي</span></div>;',
    "const classes = 'tracking-wide'; const view = <div className={classes} />;",
    "const classes = cn('tracking-wide'); const view = <div className={classes} />;",
  ])('rejects %s', (code) => {
    expect(errors(code)).toHaveLength(1);
    expect(errors(code)[0]).toMatchObject({ messageId: 'tracking' });
  });

  test('the existing direction and font-size errors remain mandatory', () => {
    expect(
      errors('<div className="mr-4 text-[12px]" />;').map(
        (message) => message.messageId
      )
    ).toEqual(['physical', 'fontSize']);
  });
});

describe('the lint command preserves warning policy', () => {
  test.each([
    ['fixed color', '<div className="text-red-500" />;', 0, FIXED_COLOR_RULE],
    [
      'mandatory rule',
      '<div className="tracking-wide" />;',
      1,
      'tailwind/class-conventions',
    ],
    ['another warning', 'debugger;', 1, 'no-debugger'],
  ])(
    '%s',
    async (_label, code, exitCode, ruleId) => {
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'tailwind-lint-'));
      const runner = path.resolve(import.meta.dir, '../lint.mjs');
      const pluginUrl = pathToFileURL(
        path.resolve(
          import.meta.dir,
          '../../eslint-rules/tailwind-conventions.mjs'
        )
      ).href;
      try {
        await writeFile(path.join(scratch, 'probe.jsx'), code);
        await writeFile(
          path.join(scratch, 'eslint.config.mjs'),
          `import plugin from ${JSON.stringify(pluginUrl)};
        export default [{files:['**/*.jsx'], languageOptions:{parserOptions:{ecmaFeatures:{jsx:true}}}, plugins:{tailwind:plugin}, rules:{'tailwind/class-conventions':'error','tailwind/fixed-colors':'warn','no-debugger':'warn'}}];`
        );
        const child = Bun.spawnSync(
          [
            process.execPath,
            runner,
            '--config',
            path.join(scratch, 'eslint.config.mjs'),
            'probe.jsx',
          ],
          { cwd: scratch, stdout: 'pipe', stderr: 'pipe' }
        );
        expect(child.exitCode).toBe(exitCode);
        expect(child.stdout.toString()).toContain(ruleId);
      } finally {
        if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir()))
          throw new Error('Unexpected scratch directory');
        await rm(scratch, { recursive: true, force: true });
      }
    },
    30_000
  );
});
