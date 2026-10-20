import './zod-jitless';

import * as z from 'zod';
import { localizedIssueMessage } from '@app/shared/validation/rules';

// The server words an unauthored issue with this same function, so a form, a
// mock handler and the API answer one input with one message. A message a
// schema node authors still wins.
z.config({ customError: localizedIssueMessage });
