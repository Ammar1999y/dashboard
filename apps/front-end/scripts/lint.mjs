import { ESLint } from 'eslint';

import { FIXED_COLOR_RULE } from '../eslint-rules/tailwind-conventions.mjs';

// Fixed colors are advisory; every other warning keeps the existing zero-warning gate.
export const blocksLint = (message) =>
  message.severity === 2 ||
  (message.severity === 1 && message.ruleId !== FIXED_COLOR_RULE);

if (import.meta.main) {
  const files = [];
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--fix') options.fix = true;
    else if (arg === '--no-warn-ignored') options.warnIgnored = false;
    else if (arg === '--config') {
      const config = args[++index];
      if (!config || config.startsWith('-'))
        throw new Error('--config requires a file');
      options.overrideConfigFile = config;
    } else if (arg?.startsWith('-'))
      throw new Error(`Unsupported lint option: ${arg}`);
    else if (arg) files.push(arg);
  }

  const eslint = new ESLint(options);
  const results = await eslint.lintFiles(files.length > 0 ? files : ['.']);
  if (options.fix) await ESLint.outputFixes(results);
  const formatter = await eslint.loadFormatter('stylish');
  process.stdout.write(await formatter.format(results));
  if (
    results.some((result) =>
      options.fix ? result.errorCount > 0 : result.messages.some(blocksLint)
    )
  )
    process.exitCode = 1;
}
