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
const checkAnswer = documentCheck(await servedDocument(), [
  REFERENCE_PAGE_ROUTE.path,
]);

// The first wrap is the outermost: `app.wrap` would add this one inside the
// exit step's, which rewrites a Better Auth refusal into its problem after it
// had been checked, and takes a HEAD's body. A HEAD here has none, so only its
// status is held to the document.
const check: Parameters<typeof app.wrap>[0] =
  (fetch) =>
  async (request: Request, ...rest: unknown[]) => {
    const response = await fetch(request, ...rest);
    const problems = await checkAnswer(request, response);
    for (const problem of problems) recordResponseMismatch(problem);
    return response;
  };
const ext = app['~ext'];
if (!ext?.hoc || !ext.hocOrigin)
  throw new Error(
    'the application has no wraps to put the document check before'
  );
ext.hoc.unshift(check);
ext.hocOrigin.unshift({});
