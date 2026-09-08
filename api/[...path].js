// Vercel's catch-all: every request under /api/ arrives here with its original
// path intact on req.url, which is what lets the Express app match its own
// routes ("/api/registrations", "/api/auth/login") unchanged. A file at
// api/index.js would answer only /api and /api/index.
//
// ESM syntax because the repository root declares "type": "module" - a .js file
// here is an ES module whatever the server package says. The server half is
// CommonJS, so its module.exports arrives as this import's default.
import handler from '../server/api/index.js';

export default handler;
