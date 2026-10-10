import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { usePglite } from '../../db/testing';

/**
 * The file store — how it is configured and how a (bucket, path) becomes an S3
 * key — and who the notification feed shows what.
 *
 * No network and no server. S3 is an in-memory double; the feed runs in pglite
 * through the real query layer.
 */

type Store = typeof import('../file-store');
let fs: Store;
let feed: typeof import('../notification-feed.service');
let pg: PGlite;

/** In-memory S3 covering the four commands the file store sends. */
class FakeS3 {
  objects = new Map<string, { body: Buffer; contentType?: string; sse?: string }>();
  refuseDelete = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(command: any): Promise<any> {
    const name: string = command.constructor.name;
    const input = command.input ?? {};
    switch (name) {
      case 'PutObjectCommand':
        this.objects.set(input.Key, { body: input.Body, contentType: input.ContentType, sse: input.ServerSideEncryption });
        return {};
      case 'HeadObjectCommand': {
        const o = this.objects.get(input.Key);
        if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        return { ContentLength: o.body.length };
      }
      case 'DeleteObjectsCommand': {
        const errors: { Key: string; Message: string }[] = [];
        for (const { Key } of input.Delete.Objects as { Key: string }[]) {
          if (this.refuseDelete.has(Key)) errors.push({ Key, Message: 'AccessDenied' });
          else this.objects.delete(Key);
        }
        return { Errors: errors };
      }
      default:
        throw new Error(`FakeS3: unsupported command ${name}`);
    }
  }
}

const cfg = { bucket: 'test-bucket', prefix: 'files', publicApiUrl: 'https://api.example.com' };
const sign = async (key: string, ttl: number) => `https://signed.example/${key}?ttl=${ttl}`;

before(async () => {
  fs = await import('../file-store');
  feed = await import('../notification-feed.service');

  pg = new PGlite();
  await pg.exec(`
    create table notifications (
      id uuid primary key default gen_random_uuid(), type text, title text, message text,
      is_read boolean not null default false, target_user_id uuid, target_role text, branch_id uuid,
      related_id uuid, created_at timestamptz not null default now());
    create table notification_reads (
      notification_id uuid not null references notifications (id), user_id uuid not null,
      read_at timestamptz not null default now(), primary key (notification_id, user_id));
  `);
  await usePglite(pg);
});

describe('file store — configuration', () => {
  test('s3 config names every missing setting at once', () => {
    assert.throws(() => fs.s3FileConfig({}), (err: Error) =>
      /FILES_S3_BUCKET is required/.test(err.message) && /PUBLIC_API_URL must be/.test(err.message));
  });

  test('s3 config never falls back to the backup bucket', () => {
    assert.throws(
      () => fs.s3FileConfig({ BACKUP_S3_BUCKET: 'backups', AWS_S3_BUCKET_NAME: 'legacy', PUBLIC_API_URL: 'https://api.example.com' }),
      /FILES_S3_BUCKET is required/,
    );
  });

  test('s3 config trims the prefix and the trailing slash of the API URL', () => {
    assert.deepEqual(
      fs.s3FileConfig({ FILES_S3_BUCKET: 'b', FILES_S3_PREFIX: '/uploads/live/', PUBLIC_API_URL: 'https://api.example.com/' }),
      { bucket: 'b', prefix: 'uploads/live', publicApiUrl: 'https://api.example.com' },
    );
  });

  test('s3 config refuses an API URL that carries a path', () => {
    assert.throws(
      () => fs.s3FileConfig({ FILES_S3_BUCKET: 'b', PUBLIC_API_URL: 'https://api.example.com/api' }),
      /PUBLIC_API_URL must be/,
    );
  });
});

describe('file store — S3 driver', () => {
  let s3: FakeS3;
  let store: import('../file-store').FileStore;

  beforeEach(() => {
    s3 = new FakeS3();
    store = fs.createS3FileStore(cfg, s3, sign);
  });

  test('a file lands at <prefix>/<bucket>/<path>, encrypted, with its content type', async () => {
    await store.upload('attachments', 'branch_return/abc.webp', Buffer.from('photo'), 'image/webp');
    const stored = s3.objects.get('files/attachments/branch_return/abc.webp');
    assert.ok(stored);
    assert.equal(stored.contentType, 'image/webp');
    assert.equal(stored.sse, 'AES256');
    assert.equal(stored.body.toString(), 'photo');
  });

  test('signed URLs come back keyed by the path that was asked for', async () => {
    const urls = await store.signUrls('attachments', ['a/1.jpg', 'b/2.png'], 3600);
    assert.equal(urls.get('a/1.jpg'), 'https://signed.example/files/attachments/a/1.jpg?ttl=3600');
    assert.equal(urls.get('b/2.png'), 'https://signed.example/files/attachments/b/2.png?ttl=3600');
    assert.equal(urls.size, 2);
  });

  test('a path that cannot be signed is left out rather than failing the batch', async () => {
    const flaky = fs.createS3FileStore(cfg, s3, async (key, ttl) => {
      if (key.endsWith('bad.jpg')) throw new Error('no credentials');
      return sign(key, ttl);
    });
    const urls = await flaky.signUrls('attachments', ['good.jpg', 'bad.jpg'], 60);
    assert.deepEqual([...urls.keys()], ['good.jpg']);
  });

  test('remove deletes only the named files', async () => {
    await store.upload('attachments', 'keep.jpg', Buffer.from('k'), 'image/jpeg');
    await store.upload('attachments', 'drop.jpg', Buffer.from('d'), 'image/jpeg');
    await store.remove('attachments', ['drop.jpg']);
    assert.deepEqual([...s3.objects.keys()], ['files/attachments/keep.jpg']);
  });

  test('remove throws when S3 refuses a key inside an otherwise successful batch', async () => {
    await store.upload('attachments', 'locked.jpg', Buffer.from('x'), 'image/jpeg');
    s3.refuseDelete.add('files/attachments/locked.jpg');
    await assert.rejects(store.remove('attachments', ['locked.jpg']), /refused to delete 1 object/);
  });

  test('remove batches at the S3 limit of 1000 keys', async () => {
    let calls = 0;
    const counting = { send: async (c: unknown) => { calls++; return s3.send(c); } };
    await fs.createS3FileStore(cfg, counting, sign).remove('attachments', Array.from({ length: 2001 }, (_, i) => `f${i}.jpg`));
    assert.equal(calls, 3);
  });

  test('the logo URL is served by this API; attachments have no public URL', () => {
    assert.equal(
      store.publicUrl('branding', 'settings/logo-1728000000000.png'),
      'https://api.example.com/api/public/branding/settings/logo-1728000000000.png',
    );
    assert.throws(() => store.publicUrl('attachments', 'x.jpg'), /private/);
  });

  test('s3ObjectSize reports the stored size, and null for a missing object', async () => {
    await store.upload('branding', 'settings/logo-1.png', Buffer.from('12345'), 'image/png');
    assert.equal(await fs.s3ObjectSize(cfg, s3, 'branding', 'settings/logo-1.png'), 5);
    assert.equal(await fs.s3ObjectSize(cfg, s3, 'branding', 'settings/logo-2.png'), null);
  });
});

describe('file store — public logo path', () => {
  test('only a path shaped like an uploaded logo is servable', () => {
    for (const ok of ['settings/logo-1728000000000.png', 'settings/logo-1.jpg', 'settings/logo-99.webp', 'settings/logo-5.svg']) {
      assert.ok(fs.LOGO_PATH_PATTERN.test(ok), ok);
    }
    for (const bad of [
      '../attachments/expense/abc.jpg',
      'settings/../../attachments/x.jpg',
      'settings/logo-1.png/../../secret',
      'settings/logo-abc.png',
      'settings/logo-1.gif',
      'expense/logo-1.png',
      '',
    ]) {
      assert.ok(!fs.LOGO_PATH_PATTERN.test(bad), bad);
    }
  });
});

describe('file store — the store in use', () => {
  test('a store handed in is the one used, until it is taken back out', () => {
    const fake = fs.createS3FileStore(cfg, new FakeS3(), sign);
    fs.setFileStore(fake);
    assert.equal(fs.fileStore(), fake);
    fs.setFileStore();
    // Back to the environment, which in a test names no bucket.
    const saved = { bucket: process.env['FILES_S3_BUCKET'], api: process.env['PUBLIC_API_URL'] };
    delete process.env['FILES_S3_BUCKET'];
    delete process.env['PUBLIC_API_URL'];
    try {
      assert.throws(() => fs.fileStore(), /FILES_S3_BUCKET is required/);
    } finally {
      if (saved.bucket !== undefined) process.env['FILES_S3_BUCKET'] = saved.bucket;
      if (saved.api !== undefined) process.env['PUBLIC_API_URL'] = saved.api;
    }
  });
});

describe('notification feed — who may see what', () => {
  const UID = '11111111-1111-4111-8111-111111111111';
  const OTHER = '11111111-1111-4111-8111-222222222222';
  const BRANCH = '22222222-2222-4222-8222-222222222222';
  const ELSEWHERE = '22222222-2222-4222-8222-333333333333';
  const ids: Record<string, string> = {};

  before(async () => {
    const add = async (title: string, target: { user?: string; role?: string; branch?: string }) => {
      const r = await pg.query<{ id: string }>(
        `insert into notifications (type, title, message, target_user_id, target_role, branch_id)
         values ('info', $1, '', $2, $3, $4) returning id`,
        [title, target.user ?? null, target.role ?? null, target.branch ?? null],
      );
      ids[title] = r.rows[0]!.id;
    };
    await add('mine', { user: UID });
    await add('someone else\'s', { user: OTHER });
    await add('managers everywhere', { role: 'branch_manager' });
    await add('managers here', { role: 'branch_manager', branch: BRANCH });
    await add('managers elsewhere', { role: 'branch_manager', branch: ELSEWHERE });
    await add('admins everywhere', { role: 'super_admin' });
    await add('admins at a branch', { role: 'super_admin', branch: BRANCH });
  });

  const titles = async (reader: Parameters<typeof feed.getNotificationFeed>[0]) =>
    (await feed.getNotificationFeed(reader)).notifications.map((n) => n.title).sort();

  test('a branch user sees their own, plus role broadcasts for their branch or for no branch', async () => {
    assert.deepEqual(
      await titles({ uid: UID, role: 'branch_manager', branchId: BRANCH }),
      ['managers everywhere', 'managers here', 'mine'],
    );
  });

  test('a user with no branch never matches a branch-scoped broadcast', async () => {
    assert.deepEqual(await titles({ uid: UID, role: 'super_admin', branchId: null }), ['admins everywhere', 'mine']);
  });

  test('ids that are not UUIDs are refused rather than built into a filter', async () => {
    await assert.rejects(
      feed.getNotificationFeed({ uid: `${UID},target_role.eq.super_admin`, role: 'branch_manager', branchId: null }),
      /not a UUID/,
    );
    await assert.rejects(
      feed.getNotificationFeed({ uid: UID, role: 'branch_manager', branchId: 'x),or(id.not.is.null' }),
      /not a UUID/,
    );
  });

  test('marking read writes only for what the reader can see, and once', async () => {
    const reader = { uid: UID, role: 'branch_manager' as const, branchId: BRANCH };
    const written = await feed.markNotificationsRead(reader, [ids['mine']!, ids['someone else\'s']!, ids['managers elsewhere']!]);
    assert.deepEqual(written, [ids['mine']]);
    assert.deepEqual(await feed.markNotificationsRead(reader, [ids['mine']!]), [ids['mine']]);

    const rows = await pg.query<{ notification_id: string; user_id: string }>(`select notification_id, user_id from notification_reads`);
    assert.deepEqual(rows.rows, [{ notification_id: ids['mine'], user_id: UID }]);
    assert.deepEqual((await feed.getNotificationFeed(reader)).readIds, [ids['mine']]);
  });
});
