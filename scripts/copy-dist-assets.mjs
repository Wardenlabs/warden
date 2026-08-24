/**
 * The compiled red-team runner reads its corpus from a directory next to
 * itself (dist/redteam/corpus), mirroring where the source keeps it. tsc only
 * emits .ts files, so the JSON corpus is copied in as the last build step.
 */
import { cpSync } from 'node:fs';

cpSync('src/redteam/corpus', 'dist/redteam/corpus', { recursive: true });
