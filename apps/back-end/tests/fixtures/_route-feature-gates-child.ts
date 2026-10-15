/**
 * Subprocess body for `route-feature-gates.test.ts`: the phone mode is a source
 * constant read at module load, so this replaces it before anything reads it.
 * Prints ONE line of JSON.
 */
import { mock } from 'bun:test';

import * as config from '@app/shared/config';

import { installEgressGuard } from '../helpers/egress';

await mock.module('@app/shared/config', () => ({
  ...config,
  PHONE_ENABLED: false,
}));

installEgressGuard();
const { routeReport } = await import('../helpers/route-report');

console.log(JSON.stringify({ routes: await routeReport() }));
