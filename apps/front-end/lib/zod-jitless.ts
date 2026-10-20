import * as z from 'zod';

// zod probes `new Function` when it builds its first object schema, which a
// CSP without 'unsafe-eval' reports. Only `zod` is imported here, so this runs
// before any module that builds one.
z.config({ jitless: true });
