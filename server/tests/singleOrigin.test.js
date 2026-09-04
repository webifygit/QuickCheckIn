import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

// This file exercises the single-service deployment: one process serving both
// the API and the built client, which is what removes CORS configuration and a
// bake-time API URL from a deploy. CLIENT_DIST_DIR has to be set before the app
// is loaded, because config reads it once at require time - so the app is
// imported inside beforeAll rather than at the top of the file.
let app;
let distDir;

const ASSET = 'assets/index-abc123.js';

beforeAll(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quickcheckin-dist-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    '<!doctype html><html><head><title>Hotel Guest Registration</title></head><body><div id="root"></div></body></html>'
  );
  fs.writeFileSync(path.join(distDir, ASSET), 'console.log("bundle")');

  process.env.CLIENT_DIST_DIR = distDir;
  const { loadAppWithPrismaMock } = await import('./helpers/app.js');
  ({ app } = loadAppWithPrismaMock());
});

afterAll(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
  delete process.env.CLIENT_DIST_DIR;
});

describe('serving the client and the API from one origin', () => {
  // Every one of these is a client-side route, not a file on disk. Without the
  // fallback, a guest who reloads the page - or opens the link you handed them -
  // gets a 404 from the server rather than the app.
  it.each(['/', '/register', '/login', '/dashboard', '/dashboard/some-id'])(
    'serves the app at %s',
    async (route) => {
      const res = await request(app).get(route);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.text).toContain('id="root"');
    }
  );

  // The fallback must not reach across the API. Handing HTML to a fetch that
  // asked for JSON turns a mistyped path into a parse error somewhere else.
  it('still answers an unknown API path with JSON', async () => {
    const res = await request(app).get('/api/no-such-route');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('leaves real API routes alone', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // index.html names the hashed bundles. A cached copy points at asset files
  // that no longer exist after a deploy, which is a white screen.
  it('never caches the HTML shell', async () => {
    const res = await request(app).get('/register');

    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('caches hashed assets hard, because their names change on every build', async () => {
    const res = await request(app).get(`/${ASSET}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/max-age=31536000/);
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  it('sends a content security policy with the page', async () => {
    const res = await request(app).get('/register');

    const csp = res.headers['content-security-policy'];
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/script-src 'self'/);
    // The guest's photo is previewed from a blob: URL before it is uploaded.
    expect(csp).toMatch(/img-src[^;]*blob:/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });
});

describe('CORS when the page and the API share an origin', () => {
  // Vite marks the module script and stylesheet `crossorigin`, so the browser
  // sends an Origin header even though nothing is crossing an origin. Judging
  // that against CORS_ORIGINS alone 403s the app's own JavaScript, and the page
  // comes up blank with no error near the cause.
  it('allows a request whose origin is the host being addressed', async () => {
    const res = await request(app)
      .get(`/${ASSET}`)
      .set('Host', 'demo.hotel.test')
      .set('Origin', 'http://demo.hotel.test');

    expect(res.status).toBe(200);
  });

  it('still refuses an origin that is neither the host nor in CORS_ORIGINS', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Host', 'demo.hotel.test')
      .set('Origin', 'https://evil.example');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/origin not allowed/i);
  });

  // A same-origin match must not be forgeable by claiming a different scheme.
  it('does not treat a mismatched scheme as same-origin', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Host', 'demo.hotel.test')
      .set('Origin', 'https://demo.hotel.test');

    expect(res.status).toBe(403);
  });
});
