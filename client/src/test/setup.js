import '@testing-library/jest-dom/vitest';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from './server.js';

// jsdom ships its own Blob, File and FormData. The fetch implementation msw
// intercepts is Node's, and it cannot read them: a request with a FormData body
// is never encoded and the call hangs until the test times out - which is what
// the ID-upload tests do without this. Swapping in Node's own classes is what
// lets a multipart request be asserted on at all.
//
// FormData has no importable path, so it is taken off an instance Node itself
// produced.
beforeAll(async () => {
  globalThis.Blob = NodeBlob;
  globalThis.File = NodeFile;
  globalThis.FormData = (
    await new Response('field=value', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }).formData()
  ).constructor;

  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

afterAll(() => server.close());
