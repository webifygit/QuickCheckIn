// Set before any app module loads. dotenv does not override existing env vars,
// so these win over whatever sits in server/.env.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-production';
process.env.UPLOAD_DIR = new URL('./.tmp-uploads', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://unused:unused@localhost:5432/unused';
