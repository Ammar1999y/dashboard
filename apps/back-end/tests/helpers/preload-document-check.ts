/**
 * The preload `tests/helpers/run.ts` adds after the database preload on the
 * tiers that drive the application in process: every answer is held to the
 * served document (`./document-check.ts`), and a mismatch fails the test that
 * caused it through the same gate as the runtime check (`./preload-base.ts`).
 *
 * Imported here, not at the top: the application reads the database the
 * preload before this one points it at, at load.
 */
const [
  { app },
  { servedDocument },
  { recordResponseMismatch },
  { REFERENCE_PAGE_ROUTE },
  { documentCheck },
] = await Promise.all([
  import('@/app'),
  import('@/lib/http/openapi/serve'),
  import('@/lib/http/response-mismatches'),
  import('@/server/elysia/openapi'),
  import('./document-check'),
]);

// Generated before the first test, whose timeout would otherwise pay for it.
const check = documentCheck(await servedDocument(), [
  REFERENCE_PAGE_ROUTE.path,
]);

// A later wrap runs inside the exit step's, so a HEAD still carries its GET's
// body here.
app.wrap((fetch) => async (request: Request, ...rest: unknown[]) => {
  const response = await fetch(request, ...rest);
  const problems = await check(request, response);
  for (const problem of problems) recordResponseMismatch(problem);
  return response;
});
