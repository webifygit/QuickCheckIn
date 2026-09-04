import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Node 19 turned keep-alive on for the global HTTP agent. supertest binds a
// fresh ephemeral port for every request, so a pooled socket can outlive the
// server it was opened to and be handed back for a port the OS has since
// reassigned to another test file's app - which arrives as an unexplained 404,
// or as a response the HTTP parser cannot make sense of at all. Both only ever
// showed up on a full parallel run, never on a single file.
http.globalAgent.keepAlive = false;
http.globalAgent.options.keepAlive = false;

// Set before any app module loads. dotenv does not override existing env vars,
// so these win over whatever sits in server/.env.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-production';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://unused:unused@localhost:5432/unused';

// One upload directory per test file, not one shared by all of them. Vitest runs
// files in parallel, and the storage tests both count what is in this directory
// and delete it wholesale on the way out - against a shared path, one file
// sweeps another's uploads mid-assertion. That was an intermittent failure that
// only ever reproduced on a full run.
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quickcheckin-test-uploads-'));

// Whatever a file leaves behind goes with it, so a run does not accumulate
// temp directories.
afterAll(() => {
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
});
