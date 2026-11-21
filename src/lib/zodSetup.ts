/**
 * Zod settings for the site. Imported first in main.tsx, before any module that defines a schema: zod decides whether
 * to compile a fast parser (which needs `new Function`) when each object schema is created, and probes for `new Function`
 * then. The site's Content-Security-Policy allows no 'unsafe-eval', so that probe would be reported as a violation on
 * every page; with `jitless` it is never made, and the schemas are checked by zod's ordinary parser.
 */
import { config } from 'zod';

config({ jitless: true });
