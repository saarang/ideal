/**
 * Private file storage behind a small adapter, so the local-disk driver used
 * in development can be swapped for S3-compatible object storage (Supabase
 * Storage, AWS S3, Cloudflare R2) without touching callers.
 *
 * Files are NEVER publicly addressable: the only read path is the
 * authenticated /api/files/[pageId] route, which streams via this adapter.
 *
 * To connect real object storage:
 *   1. set STORAGE_DRIVER=s3 plus S3_BUCKET / S3_REGION / S3_ENDPOINT /
 *      S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *   2. implement the three methods in S3Storage below with @aws-sdk/client-s3
 *      (kept out of the default dependency tree deliberately)
 *   3. run `npm i @aws-sdk/client-s3`
 */
import fs from 'fs/promises';
import path from 'path';

export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

class LocalStorage implements Storage {
  private root: string;
  constructor() {
    this.root = path.resolve(process.env.DATA_DIR || './data', 'storage');
  }
  private full(key: string) {
    const p = path.normalize(path.join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.full(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  }
  async get(key: string) { return fs.readFile(this.full(key)); }
  async exists(key: string) { try { await fs.access(this.full(key)); return true; } catch { return false; } }
}

class S3Storage implements Storage {
  async put(): Promise<void> { throw new Error('S3 driver not wired: see src/lib/storage/index.ts for 3-step instructions'); }
  async get(): Promise<Buffer> { throw new Error('S3 driver not wired: see src/lib/storage/index.ts'); }
  async exists(): Promise<boolean> { throw new Error('S3 driver not wired: see src/lib/storage/index.ts'); }
}

let storage: Storage | null = null;
export function getStorage(): Storage {
  if (!storage) storage = (process.env.STORAGE_DRIVER === 's3') ? new S3Storage() : new LocalStorage();
  return storage;
}
