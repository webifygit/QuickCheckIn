const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');

// Uploaded ID images are sensitive, so storage is deliberately narrow: put a
// buffer in, read it back, delete it. Nothing hands out a public URL, and
// nothing is ever served straight off a static path.
//
// Two drivers, chosen by STORAGE_DRIVER:
//   local - a directory on disk. Fine for a VPS with a persistent volume.
//   s3    - any S3-compatible bucket. Required on ephemeral-disk platforms
//           (Render, Railway, Fly, Heroku), where local files vanish on deploy.

const UPLOAD_DIR = config.UPLOAD_DIR
  ? path.resolve(config.UPLOAD_DIR)
  : path.join(__dirname, '..', '..', 'uploads');

const EXTENSION_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// 128 bits of randomness. Keys are never guessable even if one leaks.
function buildKey(mimeType) {
  const extension = EXTENSION_BY_MIME[mimeType] || '.bin';
  return `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${extension}`;
}

// A stored key must stay a bare filename. Anything with a separator or a parent
// segment is a traversal attempt and is refused before it reaches the filesystem.
function assertSafeKey(key) {
  if (typeof key !== 'string' || !key) {
    throw new Error('Invalid storage key');
  }
  if (key !== path.basename(key) || key.includes('..')) {
    throw new Error('Invalid storage key');
  }
  return key;
}

const localDriver = {
  name: 'local',

  async init() {
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  },

  async save(buffer, mimeType) {
    const key = buildKey(mimeType);
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    await fsp.writeFile(path.join(UPLOAD_DIR, key), buffer);
    return key;
  },

  async read(key) {
    const filePath = path.join(UPLOAD_DIR, assertSafeKey(key));
    try {
      return await fsp.readFile(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  },

  async remove(key) {
    const filePath = path.join(UPLOAD_DIR, assertSafeKey(key));
    try {
      await fsp.unlink(filePath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  },

  // Used by the orphan sweeper: everything currently held, with its age.
  async list() {
    try {
      const names = await fsp.readdir(UPLOAD_DIR);
      const entries = [];
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const stat = await fsp.stat(path.join(UPLOAD_DIR, name)).catch(() => null);
        if (stat?.isFile()) entries.push({ key: name, modifiedAt: stat.mtime });
      }
      return entries;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  },
};

function createS3Driver() {
  const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
  } = require('@aws-sdk/client-s3');

  const client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT || undefined,
    // Non-AWS S3 implementations (MinIO, R2, Spaces) need path-style addressing.
    forcePathStyle: Boolean(config.S3_ENDPOINT),
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
  });

  const Bucket = config.S3_BUCKET;

  return {
    name: 's3',

    async init() {
      // Nothing to create; the bucket is expected to exist and stay private.
    },

    async save(buffer, mimeType) {
      const key = buildKey(mimeType);
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: buffer,
          ContentType: mimeType,
          ServerSideEncryption: 'AES256',
        })
      );
      return key;
    },

    async read(key) {
      assertSafeKey(key);
      try {
        const result = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return Buffer.from(await result.Body.transformToByteArray());
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },

    async remove(key) {
      assertSafeKey(key);
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
      return true;
    },

    async list() {
      const entries = [];
      let ContinuationToken;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
        for (const object of page.Contents || []) {
          entries.push({ key: object.Key, modifiedAt: object.LastModified });
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return entries;
    },
  };
}

const storage = config.STORAGE_DRIVER === 's3' ? createS3Driver() : localDriver;

logger.info({ driver: storage.name }, 'Upload storage initialised');

module.exports = { storage, UPLOAD_DIR, assertSafeKey };
