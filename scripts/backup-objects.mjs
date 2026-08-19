#!/usr/bin/env node
// The half of disaster recovery that scripts/backup.sh does not cover.
//
// backup.sh dumps Postgres. On this deployment MinIO runs in the SAME compose
// stack on the SAME VPS, so the box that loses the database also loses every
// merchant's product images. Restoring only the database produces the worst
// kind of "successful" recovery: every order, customer and product comes back,
// the site is up, and every product page renders a broken image — because
// `ProductImage.url` still points at objects that no longer exist. Nothing in
// the schema can detect that; it is only visible to a human looking at a page.
//
// So the backup SET is: dump + globals + manifest + checksums (backup.sh),
// AND the object archive + its manifest + checksums (this script). A recovery
// is not consistent unless both halves come from the same night.
//
// Deliberately shaped like backup.sh and backup-upload.mjs, because an
// operator at 3am should not have to learn a second set of conventions:
//
//   ventia-objects-<bucket>-<STAMP>.tar            every object, plain tar
//   ventia-objects-<bucket>-<STAMP>.manifest.json  what was true at dump time
//   ventia-objects-<bucket>-<STAMP>.sha256         checksums of the two above
//
// ...written to the same BACKUP_DIR, pruned by the same BACKUP_RETENTION_DAYS,
// uploaded to the same offsite bucket (under its own prefix), verified by
// read-back the same way, and — per scripts/restore-drill.sh's posture, that a
// backup nobody has restored is an assumption — drillable with `--drill`.
//
// WHY A PLAIN TAR, and not gzip, and not a directory of files:
//   * Plain, uncompressed: the payload is JPEG/PNG/WebP, already compressed.
//     gzip would spend CPU on a 2 GB VPS to save ~0%.
//   * tar, not a bespoke container: `tar -xf` recovers one merchant's image
//     on any machine, with no Node, no credentials, and no copy of this repo.
//     At 3am that property is worth more than any format cleverness.
//   * One file, not a tree: it is checksummed, uploaded and verified as a
//     single artifact, the way the .dump is.
//
// WHAT THIS IS NOT: it is a FULL copy every run. That is right at pilot scale
// (a handful of merchants, a few hundred images) and wrong at some point past
// it — a nightly full copy of 50 GB is neither cheap nor fast. The script says
// so out loud once the bucket crosses BACKUP_OBJECTS_MAX_BYTES rather than
// quietly getting slower every night. There is no incremental mode and no
// object versioning here; adding either is a real decision, not a tweak.
//
// Usage:
//   node scripts/backup-objects.mjs                  # archive the bucket
//   node scripts/backup-objects.mjs --upload [ARCH]  # copy a run offsite, verified
//   node scripts/backup-objects.mjs --list           # what is offsite right now
//   node scripts/backup-objects.mjs --pull [RUN] [DIR]
//   node scripts/backup-objects.mjs --drill [--latest | ARCH]
//
// Env:
//   S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY
//                           the SOURCE bucket — the same four the API uses
//                           (services/api/src/storage/storage.module.ts), so
//                           there is one set of credentials, not two.
//   BACKUP_DIR              default ${TMPDIR:-/tmp}/ventia-backups (as backup.sh)
//   BACKUP_RETENTION_DAYS   default 30
//   BACKUP_S3_*             offsite target, as backup-upload.mjs
//   BACKUP_S3_OBJECTS_PREFIX  default "objects/" — kept separate from the
//                           "postgres/" prefix so `--list` on either script
//                           shows only its own runs
//   BACKUP_OBJECTS_MAX_BYTES  default 2 GiB — warn threshold, not a limit
//   BACKUP_OBJECTS_DRILL_LIMIT  default 0 (all) — drill only the first N
//                           objects; a sampled drill SAYS it was sampled
//   KEEP_DRILL_BUCKET=1     keep the scratch bucket for a post-mortem
//
// Exit codes: 0 success; 1 anything else. There is no partial success — an
// archive missing objects is not a backup of the bucket, it is a subset of it.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };
const fail = (msg) => {
  console.error(`${C.red}error:${C.off} ${msg}`);
  process.exit(1);
};

const SRC = {
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  accessKey: process.env.S3_ACCESS_KEY,
  secretKey: process.env.S3_SECRET_KEY,
};
const BACKUP_DIR = process.env.BACKUP_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'ventia-backups');
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
const MAX_BYTES = Number(process.env.BACKUP_OBJECTS_MAX_BYTES ?? 2 * 1024 ** 3);
const DRILL_LIMIT = Number(process.env.BACKUP_OBJECTS_DRILL_LIMIT ?? 0);
const OFFSITE_PREFIX = process.env.BACKUP_S3_OBJECTS_PREFIX ?? 'objects/';

function sourceClient() {
  for (const [name, value] of [
    ['S3_ENDPOINT', SRC.endpoint],
    ['S3_BUCKET', SRC.bucket],
    ['S3_ACCESS_KEY', SRC.accessKey],
    ['S3_SECRET_KEY', SRC.secretKey],
  ]) {
    // Refuse rather than fall back to the dev defaults in storage.module.ts.
    // A backup that silently archived an empty local MinIO instead of the
    // production bucket would report success every night.
    if (!value) fail(`${name} is not set. This script needs the SAME object-store credentials the API uses; see /etc/ventia/cron.env.`);
  }
  return new S3Client({
    endpoint: SRC.endpoint,
    region: 'auto',
    forcePathStyle: true, // as services/api/src/storage/storage.service.ts — required by MinIO, correct for R2
    credentials: { accessKeyId: SRC.accessKey, secretAccessKey: SRC.secretKey },
  });
}

function offsiteClient() {
  const cfg = {
    endpoint: process.env.BACKUP_S3_ENDPOINT,
    bucket: process.env.BACKUP_S3_BUCKET,
    accessKey: process.env.BACKUP_S3_ACCESS_KEY,
    secretKey: process.env.BACKUP_S3_SECRET_KEY,
  };
  for (const [envName, value] of [
    ['BACKUP_S3_ENDPOINT', cfg.endpoint],
    ['BACKUP_S3_BUCKET', cfg.bucket],
    ['BACKUP_S3_ACCESS_KEY', cfg.accessKey],
    ['BACKUP_S3_SECRET_KEY', cfg.secretKey],
  ]) {
    if (!value) fail(`${envName} is not set — offsite is all four variables or none, never half.`);
  }
  return [
    new S3Client({
      endpoint: cfg.endpoint,
      region: 'auto',
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    }),
    cfg,
  ];
}

// ---------------------------------------------------------------------------
// ustar writer.
//
// ~70 lines instead of a dependency, because this script must keep working on
// a host where `pnpm install` has not been run since the last upgrade, and
// because the output has to be readable by the `tar` already on every Ubuntu
// box. The format is POSIX ustar (1988) and has not moved since.
// ---------------------------------------------------------------------------
const BLOCK = 512;

/** Splits a key across ustar's name[100] + prefix[155] fields.
 *  The API's keys are `tenants/<uuid>/products/<uuid>/<uuid>.<ext>` — 132
 *  chars, which does NOT fit name[100] alone, so this split is load-bearing,
 *  not theoretical. Returns null when no split works; the caller refuses the
 *  run rather than writing an archive that silently omits an object. */
function ustarSplit(key) {
  if (Buffer.byteLength(key) <= 100) return { name: key, prefix: '' };
  for (let i = key.length - 1; i > 0; i -= 1) {
    if (key[i] !== '/') continue;
    const prefix = key.slice(0, i);
    const name = key.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) {
      return { name, prefix };
    }
  }
  return null;
}

function ustarHeader(key, size, mtimeSeconds) {
  const split = ustarSplit(key);
  if (!split) return null;
  const head = Buffer.alloc(BLOCK, 0);
  const put = (str, offset, len) => head.write(str.slice(0, len), offset, len, 'utf8');
  const oct = (n, offset, len) => head.write(n.toString(8).padStart(len - 1, '0') + '\0', offset, len, 'ascii');

  put(split.name, 0, 100);
  oct(0o644, 100, 8);
  oct(0, 108, 8); // uid 0 / gid 0: the archive is restored into an object
  oct(0, 116, 8); // store, not onto a filesystem — ownership is meaningless.
  oct(size, 124, 12);
  oct(Math.floor(mtimeSeconds), 136, 12);
  head.write('        ', 148, 8, 'ascii'); // checksum field is spaces while summing
  head.write('0', 156, 1, 'ascii'); // typeflag '0' = regular file
  head.write('ustar\0', 257, 6, 'ascii');
  head.write('00', 263, 2, 'ascii');
  put('root', 265, 32);
  put('root', 297, 32);
  put(split.prefix, 345, 155);

  let sum = 0;
  for (const byte of head) sum += byte;
  head.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return head;
}

function padding(size) {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem, 0);
}

/** Reads a ustar archive back into [{key, body}] — used by --drill, so the
 *  drill parses the artifact itself rather than trusting the writer above. */
function* ustarEntries(buf) {
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const head = buf.subarray(off, off + BLOCK);
    if (head.every((b) => b === 0)) return; // end-of-archive marker
    const name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = head.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(head.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, ''), 8);
    const body = buf.subarray(off + BLOCK, off + BLOCK + size);
    yield { key: prefix ? `${prefix}/${name}` : name, body };
    off += BLOCK + size + (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));
  }
}

// ---------------------------------------------------------------------------
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function listAll(client, bucket, prefix = '') {
  const out = [];
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    out.push(...(page.Contents ?? []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  out.sort((a, b) => (a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0));
  return out;
}

async function getBuffer(client, bucket, key) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return { body: Buffer.concat(chunks), contentType: res.ContentType ?? '' };
}

/** A key that escapes its own directory when extracted, or that no tar can
 *  represent. Refused at BACKUP time, where it is a one-line fix, rather than
 *  discovered during a restore. */
function unsafeKey(key) {
  if (key.length === 0) return 'empty';
  if (key.includes('\0')) return 'contains NUL';
  if (key.startsWith('/')) return 'absolute path';
  if (key.split('/').includes('..')) return 'contains a .. segment';
  if (!ustarSplit(key)) return 'too long for ustar name[100]+prefix[155]';
  return null;
}

// ---------------------------------------------------------------------------
// archive (default mode)
// ---------------------------------------------------------------------------
async function cmdArchive() {
  const s3 = sourceClient();
  await mkdir(BACKUP_DIR, { recursive: true });

  console.log(`==> Source: ${SRC.endpoint}/${SRC.bucket}`);
  const before = await listAll(s3, SRC.bucket);
  const totalBytes = before.reduce((n, o) => n + (o.Size ?? 0), 0);
  console.log(`==> ${before.length} object(s), ${totalBytes} bytes`);

  if (before.length === 0) {
    // Not an error — a brand new deployment has no product images yet — but
    // it is the state most easily confused with "pointed at the wrong bucket",
    // so it is said plainly instead of producing a 10 KB tar with a shrug.
    console.log(`${C.yellow}warning:${C.off} the bucket is EMPTY. If this deployment has merchants with product images, the credentials or S3_BUCKET are wrong.`);
  }

  const unsafe = before.map((o) => [o.Key, unsafeKey(o.Key)]).filter(([, why]) => why);
  if (unsafe.length > 0) {
    for (const [key, why] of unsafe) console.error(`  ${C.red}unsafe key${C.off} ${why}: ${key}`);
    fail(`${unsafe.length} object key(s) cannot be safely archived. Refusing to write an archive that would omit or mis-extract them.`);
  }

  if (totalBytes > MAX_BYTES) {
    console.log(`${C.yellow}warning:${C.off} this bucket is ${(totalBytes / 1024 ** 3).toFixed(2)} GiB and this script copies ALL of it, every night.`);
    console.log('         Past this size a nightly full copy stops being the right design — the next step is');
    console.log('         object versioning or replication at the store, not a bigger tar. Set');
    console.log('         BACKUP_OBJECTS_MAX_BYTES to move the line if this is deliberate.');
  }

  const fsStat = await statfs(BACKUP_DIR).catch(() => null);
  if (fsStat) {
    const free = fsStat.bavail * fsStat.bsize;
    // 20% headroom: an archive that exactly fills the disk also stops
    // Postgres from writing, which turns a backup into an outage.
    if (totalBytes * 1.2 > free) {
      fail(`not enough space in ${BACKUP_DIR}: need ~${Math.round((totalBytes * 1.2) / 1024 ** 2)} MiB, ${Math.round(free / 1024 ** 2)} MiB free. Refusing to fill the disk.`);
    }
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const base = join(BACKUP_DIR, `ventia-objects-${SRC.bucket}-${stamp}`);
  const tarPath = `${base}.tar`;
  console.log(`==> Target: ${base}.*`);

  const out = createWriteStream(tarPath);
  const write = async (buf) => {
    if (!out.write(buf)) await once(out, 'drain');
  };

  const objects = {};
  let written = 0;
  for (const obj of before) {
    const { body, contentType } = await getBuffer(s3, SRC.bucket, obj.Key);
    // The LIST said one size and the GET returned another: the object was
    // rewritten between the two calls. The header is written from the bytes
    // actually in hand, so the archive is always self-consistent; the
    // discrepancy is recorded as non-quiescence below.
    const header = ustarHeader(obj.Key, body.length, (obj.LastModified ?? new Date()).getTime() / 1000);
    if (!header) fail(`cannot build a tar header for ${obj.Key}`);
    await write(header);
    await write(body);
    const pad = padding(body.length);
    if (pad.length) await write(pad);
    objects[obj.Key] = {
      bytes: body.length,
      sha256: sha256(body),
      contentType,
      lastModified: (obj.LastModified ?? new Date()).toISOString(),
    };
    written += 1;
    if (written % 100 === 0) console.log(`    ${written}/${before.length}`);
  }
  await write(Buffer.alloc(BLOCK * 2, 0)); // two zero blocks = end of archive
  out.end();
  await once(out, 'finish');

  // Re-list AFTER the archive, exactly as backup.sh counts rows before and
  // after pg_dump: if the bucket changed underneath, the archive is a
  // consistent snapshot of an instant this script cannot observe, and the
  // drill must know to treat "the source has an object the archive lacks" as
  // expected rather than as data loss.
  const after = await listAll(s3, SRC.bucket);
  const keysBefore = before.map((o) => `${o.Key}:${o.Size}`).join('\n');
  const keysAfter = after.map((o) => `${o.Key}:${o.Size}`).join('\n');
  const quiescent = keysBefore === keysAfter;
  if (!quiescent) {
    console.log(`${C.yellow}warning:${C.off} the bucket changed while the archive was being written (${before.length} -> ${after.length} objects).`);
    console.log('         The archive is internally consistent; the drill will treat its object-set comparison as advisory.');
  }

  const archiveBytes = (await stat(tarPath)).size;

  // The analogue of backup.sh's policyDigest: one value that changes if any
  // key, size or byte changed, so two runs can be compared without diffing
  // thousands of manifest entries.
  const objectDigest = createHash('sha256')
    .update(
      Object.entries(objects)
        .map(([k, v]) => `${k}|${v.bytes}|${v.sha256}`)
        .sort()
        .join('\n'),
    )
    .digest('hex');

  const manifest = {
    createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    kind: 'objects',
    endpoint: SRC.endpoint,
    bucket: SRC.bucket,
    archiveFile: basename(tarPath),
    archiveBytes,
    objectCount: Object.keys(objects).length,
    totalBytes: Object.values(objects).reduce((n, o) => n + o.bytes, 0),
    sourceQuiescent: quiescent,
    objectDigest,
    objects,
  };
  await writeFile(`${base}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  // Verify the archive by READING IT BACK from disk before keeping it — the
  // same reason backup.sh runs `pg_restore --list`. A truncated write, a full
  // disk or a bad key split must fail here, tonight, and not during a restore.
  const parsed = [...ustarEntries(await readFile(tarPath))];
  if (parsed.length !== manifest.objectCount) {
    await unlink(tarPath).catch(() => {});
    fail(`archive re-read found ${parsed.length} entries, expected ${manifest.objectCount} — refusing to keep it.`);
  }
  for (const entry of parsed) {
    const expected = objects[entry.key];
    if (!expected) {
      await unlink(tarPath).catch(() => {});
      fail(`archive contains an object the manifest does not: ${entry.key}`);
    }
    if (sha256(entry.body) !== expected.sha256) {
      await unlink(tarPath).catch(() => {});
      fail(`archive re-read: ${entry.key} does not match its own sha256 — refusing to keep it.`);
    }
  }
  console.log(`==> Archive verified by re-read: ${parsed.length} object(s), every sha256 matches.`);

  const lines = [`${await sha256File(tarPath)}  ${basename(tarPath)}`, `${await sha256File(`${base}.manifest.json`)}  ${basename(base)}.manifest.json`];
  await writeFile(`${base}.sha256`, `${lines.join('\n')}\n`);

  if (RETENTION_DAYS > 0) {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const name of await readdir(BACKUP_DIR)) {
      // Scoped to this script's own prefix, as backup.sh's prune is: a shared
      // BACKUP_DIR must never lose a bystander's files.
      if (!name.startsWith('ventia-objects-')) continue;
      const path = join(BACKUP_DIR, name);
      const st = await stat(path);
      if (st.mtimeMs < cutoff) {
        await unlink(path);
        console.log(`    pruned ${name}`);
      }
    }
  }

  console.log(`${C.green}==> Object backup OK${C.off}: ${manifest.objectCount} object(s), ${archiveBytes} bytes`);
  // Last line is the bare archive path, matching backup.sh's contract so a
  // caller can `tail -n1` it.
  console.log(tarPath);
}

// ---------------------------------------------------------------------------
// offsite
// ---------------------------------------------------------------------------
async function newestLocal() {
  const entries = await readdir(BACKUP_DIR).catch(() => fail(`BACKUP_DIR does not exist: ${BACKUP_DIR}`));
  const tars = entries.filter((f) => f.startsWith('ventia-objects-') && f.endsWith('.tar'));
  if (tars.length === 0) fail(`no ventia-objects-*.tar in ${BACKUP_DIR}. Run this script with no arguments first.`);
  const withTimes = await Promise.all(tars.map(async (f) => ({ f, mtime: (await stat(join(BACKUP_DIR, f))).mtimeMs })));
  withTimes.sort((a, b) => b.mtime - a.mtime);
  return join(BACKUP_DIR, withTimes[0].f);
}

async function cmdUpload(arg) {
  const [s3, cfg] = offsiteClient();
  const tarPath = arg ?? (await newestLocal());
  if (!tarPath.endsWith('.tar')) fail(`expected a path ending in .tar, got ${tarPath}`);
  const base = tarPath.slice(0, -'.tar'.length);
  const runName = basename(base);
  const files = ['.tar', '.manifest.json', '.sha256'].map((ext) => `${base}${ext}`);
  for (const f of files) {
    await stat(f).catch(() => fail(`missing ${basename(f)} — an incomplete run must not be uploaded as if it were whole`));
  }

  // Refuse to store the backup of a bucket INSIDE that same bucket. It looks
  // like it works, and then every subsequent run archives the previous run's
  // archive: the bucket doubles nightly until the disk is full, and the
  // "offsite" copy dies with the box it was supposed to survive.
  if (cfg.endpoint === SRC.endpoint && cfg.bucket === SRC.bucket) {
    fail(`the offsite target (${cfg.endpoint}/${cfg.bucket}) is the SAME bucket being backed up. Each run would archive the previous run's archive. Use a different bucket, on different hardware.`);
  }

  console.log(`${C.bold}Uploading object backup${C.off} ${runName}`);
  console.log(`  ${C.dim}to${C.off} ${cfg.endpoint}/${cfg.bucket}/${OFFSITE_PREFIX}${runName}.*`);

  for (const path of files) {
    const key = `${OFFSITE_PREFIX}${basename(path)}`;
    const localDigest = await sha256File(path);
    const size = (await stat(path)).size;
    // Streamed with an explicit ContentLength: the archive can be gigabytes
    // and readFile()ing it would be the thing that OOMs the 2 GB box this
    // whole backup exists to survive.
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        Metadata: { sha256: localDigest },
      }),
    );
    // Read back and re-hash, as backup-upload.mjs does: a 200 says the request
    // was accepted, not that the bytes that landed are the bytes you sent.
    const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    const hash = createHash('sha256');
    for await (const chunk of res.Body) hash.update(chunk);
    const remoteDigest = hash.digest('hex');
    if (remoteDigest !== localDigest) {
      fail(`${basename(path)} read back with a DIFFERENT sha256 — local ${localDigest}, remote ${remoteDigest}. Do not treat this run as backed up.`);
    }
    console.log(`  ${C.green}OK${C.off}   ${basename(path).padEnd(46)} ${String(size).padStart(12)} bytes  ${C.dim}sha256 verified by read-back${C.off}`);
  }

  if (RETENTION_DAYS > 0) {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const stale = (await listAll(s3, cfg.bucket, `${OFFSITE_PREFIX}ventia-objects-`))
      .filter((o) => o.LastModified && o.LastModified.getTime() < cutoff)
      .map((o) => ({ Key: o.Key }));
    for (let i = 0; i < stale.length; i += 1000) {
      await s3.send(new DeleteObjectsCommand({ Bucket: cfg.bucket, Delete: { Objects: stale.slice(i, i + 1000) } }));
    }
    if (stale.length) console.log(`  ${C.dim}pruned ${stale.length} offsite object(s) older than ${RETENTION_DAYS} days${C.off}`);
  }

  console.log(`${C.green}Offsite object backup OK${C.off} — 3/3 files uploaded and verified by read-back.`);
}

async function offsiteRuns(s3, cfg) {
  const objects = await listAll(s3, cfg.bucket, `${OFFSITE_PREFIX}ventia-objects-`);
  const runs = new Map();
  for (const obj of objects) {
    const name = obj.Key.slice(OFFSITE_PREFIX.length);
    const run = name.replace(/\.(tar|manifest\.json|sha256)$/, '');
    if (!runs.has(run)) runs.set(run, { run, files: [], bytes: 0, lastModified: obj.LastModified });
    const e = runs.get(run);
    e.files.push(name);
    e.bytes += obj.Size ?? 0;
    if (obj.LastModified > e.lastModified) e.lastModified = obj.LastModified;
  }
  return [...runs.values()].sort((a, b) => b.lastModified - a.lastModified);
}

async function cmdList() {
  const [s3, cfg] = offsiteClient();
  const runs = await offsiteRuns(s3, cfg);
  if (runs.length === 0) {
    console.log(`No ventia-objects-* runs under ${cfg.endpoint}/${cfg.bucket}/${OFFSITE_PREFIX}`);
    return;
  }
  console.log(`${C.bold}${runs.length} object run(s) offsite${C.off} at ${cfg.endpoint}/${cfg.bucket}/${OFFSITE_PREFIX}`);
  for (const r of runs) {
    const mark = r.files.length === 3 ? `${C.green}3/3${C.off}` : `${C.yellow}${r.files.length}/3${C.off}`;
    console.log(`  ${mark}  ${r.run}  ${String(r.bytes).padStart(12)} bytes  ${C.dim}${r.lastModified.toISOString()}${C.off}`);
  }
}

async function cmdPull(runArg, destArg) {
  const [s3, cfg] = offsiteClient();
  const runs = await offsiteRuns(s3, cfg);
  if (runs.length === 0) fail(`nothing to pull under ${cfg.endpoint}/${cfg.bucket}/${OFFSITE_PREFIX}`);
  const run = runArg ? runs.find((r) => r.run === runArg) : runs[0];
  if (!run) fail(`no such run offsite: ${runArg}. Try --list.`);
  if (run.files.length !== 3) fail(`run ${run.run} is incomplete offsite (${run.files.length}/3) and must not be restored as if it were whole`);

  const dest = destArg ?? join(BACKUP_DIR, 'pulled');
  await mkdir(dest, { recursive: true });
  for (const name of ['.tar', '.manifest.json', '.sha256'].map((e) => `${run.run}${e}`)) {
    const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: `${OFFSITE_PREFIX}${name}` }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    await writeFile(join(dest, name), Buffer.concat(chunks));
  }
  // Checked against the .sha256 written BEFORE the upload, so this verifies
  // the whole round trip rather than two numbers this script just computed.
  const expected = (await readFile(join(dest, `${run.run}.sha256`), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  for (const [digest, name] of expected) {
    const actual = await sha256File(join(dest, name));
    if (actual !== digest) fail(`${name} does NOT match the sha256 recorded at backup time. The offsite copy is not usable.`);
    console.log(`  ${C.green}OK${C.off}   ${name.padEnd(46)} ${C.dim}matches backup-time sha256${C.off}`);
  }
  console.log(`${C.green}Pulled and verified${C.off} — drill it with:`);
  console.log(`  node scripts/backup-objects.mjs --drill ${join(dest, `${run.run}.tar`)}`);
}

// ---------------------------------------------------------------------------
// drill — the point of the whole file
// ---------------------------------------------------------------------------
async function cmdDrill(arg) {
  let PASS = 0;
  let FAIL = 0;
  const check = (ok, desc, detail = '') => {
    if (ok) {
      PASS += 1;
      console.log(`  ${C.green}PASS${C.off}  ${desc}`);
    } else {
      FAIL += 1;
      console.log(`  ${C.red}FAIL${C.off}  ${desc}`);
    }
    if (detail) console.log(`        ${detail}`);
  };

  const tarPath = !arg || arg === '--latest' ? await newestLocal() : arg;
  const base = tarPath.slice(0, -'.tar'.length);
  const manifestPath = `${base}.manifest.json`;
  await stat(manifestPath).catch(() => fail(`manifest not found: ${manifestPath}`));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  console.log('==============================================================');
  console.log(` Ventia object restore drill — ${new Date().toISOString()}`);
  console.log('==============================================================');
  console.log(`==> Archive:  ${tarPath}`);
  console.log(`==> Manifest: ${manifestPath} (${manifest.objectCount} objects, ${manifest.totalBytes} bytes)`);
  console.log();

  console.log('--- Step 0: archive integrity ------------------------------');
  const sumsPath = `${base}.sha256`;
  const sums = await readFile(sumsPath, 'utf8').catch(() => null);
  if (!sums) {
    check(false, 'checksum file present', sumsPath);
  } else {
    let bad = '';
    for (const line of sums.split('\n').filter(Boolean)) {
      const [digest, name] = line.split(/\s+/);
      if ((await sha256File(join(dirname(base), name))) !== digest) bad += `${name} `;
    }
    check(bad === '', 'Checksums match the ones written at backup time', bad && `mismatched: ${bad}`);
  }

  // The archive must be readable by the tar every Ubuntu box already has —
  // not merely by the parser in this file. If this repo is gone and someone is
  // recovering a merchant's images by hand, `tar` is what they will use.
  try {
    const listing = execFileSync('tar', ['-tf', tarPath], { encoding: 'utf8' }).split('\n').filter(Boolean);
    check(
      listing.length === manifest.objectCount,
      `system tar reads the archive: ${listing.length} entries`,
      listing.length === manifest.objectCount ? '' : `manifest says ${manifest.objectCount}`,
    );
  } catch (err) {
    check(false, 'system tar reads the archive', String(err.message ?? err).split('\n')[0]);
  }

  const entries = [...ustarEntries(await readFile(tarPath))];
  let mismatched = 0;
  let missing = 0;
  for (const [key, meta] of Object.entries(manifest.objects)) {
    const entry = entries.find((e) => e.key === key);
    if (!entry) {
      missing += 1;
      continue;
    }
    if (sha256(entry.body) !== meta.sha256) mismatched += 1;
  }
  check(missing === 0 && mismatched === 0, `Every one of the ${manifest.objectCount} archived objects matches its manifest sha256`,
    missing || mismatched ? `${missing} missing, ${mismatched} byte-mismatched` : '');
  console.log();

  // ---- The actual restore. Everything above proves the archive is intact;
  // this proves it can be put back into a live object store and read out.
  console.log('--- Step 1: restore into a scratch bucket -------------------');
  const s3 = sourceClient();
  const scratch = `ventia-drill-objects-${Date.now().toString(36)}`;
  let created = false;
  try {
    // Refuse to touch a bucket that already exists — the one unforgivable
    // outcome here is a "drill" that writes into the production bucket.
    let exists = true;
    await s3.send(new HeadBucketCommand({ Bucket: scratch })).catch(() => {
      exists = false;
    });
    if (exists) fail(`scratch bucket ${scratch} already exists — refusing to write into a bucket this drill did not create`);
    if (scratch === SRC.bucket) fail('scratch bucket name collides with the source bucket');

    await s3.send(new CreateBucketCommand({ Bucket: scratch }));
    created = true;
    console.log(`==> Created scratch bucket ${scratch}`);

    const toRestore = DRILL_LIMIT > 0 ? entries.slice(0, DRILL_LIMIT) : entries;
    if (DRILL_LIMIT > 0 && entries.length > DRILL_LIMIT) {
      console.log(`${C.yellow}NOTE${C.off}  BACKUP_OBJECTS_DRILL_LIMIT=${DRILL_LIMIT}: this drill covers ${toRestore.length} of ${entries.length} objects. It is a SAMPLE, not a full restore.`);
    }

    for (const entry of toRestore) {
      await s3.send(
        new PutObjectCommand({
          Bucket: scratch,
          Key: entry.key,
          Body: entry.body,
          ContentType: manifest.objects[entry.key]?.contentType || 'application/octet-stream',
        }),
      );
    }
    const restored = await listAll(s3, scratch);
    // Compared against the MANIFEST's count, not against however many entries
    // were parsed out of the tar: a truncated archive yields fewer entries,
    // restores all of them happily, and would otherwise report PASS for
    // "restored everything it had" — which is precisely the failure.
    const expectedCount = DRILL_LIMIT > 0 ? Math.min(DRILL_LIMIT, manifest.objectCount) : manifest.objectCount;
    check(
      restored.length === expectedCount,
      `${restored.length} object(s) restored into ${scratch}`,
      restored.length === expectedCount ? '' : `the manifest says this run has ${expectedCount} — the archive is short ${expectedCount - restored.length}`,
    );

    let roundTripBad = '';
    let bytesChecked = 0;
    for (const entry of toRestore) {
      const { body } = await getBuffer(s3, scratch, entry.key);
      bytesChecked += body.length;
      if (sha256(body) !== manifest.objects[entry.key].sha256) roundTripBad += `${entry.key} `;
    }
    check(roundTripBad === '', `Every restored object read back byte-identical (${bytesChecked} bytes)`, roundTripBad && `bad: ${roundTripBad}`);

    // Compare against the SOURCE bucket as it is right now. This is what
    // catches an archive that is internally perfect but stale or pointed at
    // the wrong bucket — the failure no self-consistency check can see.
    const live = await listAll(s3, SRC.bucket);
    const liveKeys = new Set(live.map((o) => o.Key));
    const archivedKeys = new Set(Object.keys(manifest.objects));
    const onlyLive = [...liveKeys].filter((k) => !archivedKeys.has(k));
    const onlyArchived = [...archivedKeys].filter((k) => !liveKeys.has(k));
    const ageHours = (Date.now() - Date.parse(manifest.createdAt)) / 3_600_000;
    const FRESH_HOURS = Number(process.env.BACKUP_OBJECTS_FRESH_HOURS ?? 2);
    if (onlyLive.length === 0 && onlyArchived.length === 0) {
      check(true, `Archive covers exactly the ${liveKeys.size} object(s) in the live bucket`);
    } else if (ageHours > FRESH_HOURS || manifest.sourceQuiescent === false) {
      // ADVISORY, not a failure, and this is deliberate. Merchants upload and
      // delete product images continuously; last night's archive differing
      // from this morning's bucket is normal operation, not a defect. A drill
      // that reports normal operation as FAIL is a drill people learn to
      // ignore — the same reasoning restore-drill.sh's grant-matrix check is
      // written up with. The numbers are still printed, because a sudden jump
      // in them is worth a human's attention.
      check(true, `Archive vs live bucket (ADVISORY — archive is ${ageHours.toFixed(1)}h old${manifest.sourceQuiescent === false ? ', and the bucket was not quiescent when it was taken' : ''})`,
        `${onlyLive.length} object(s) added since the archive, ${onlyArchived.length} deleted since`);
    } else {
      // A FRESH archive that is already missing live objects is a real defect:
      // nothing had time to change, so the archive skipped them.
      check(onlyLive.length === 0,
        `A ${ageHours.toFixed(1)}h-old archive covers every object in the live bucket`,
        `${onlyLive.length} object(s) exist live but are NOT in the archive: ${onlyLive.slice(0, 3).join(' ')}${onlyLive.length > 3 ? ' ...' : ''}`);
    }

    if (toRestore.length > 0) {
      const probe = toRestore[0];
      const liveCopy = liveKeys.has(probe.key) ? (await getBuffer(s3, SRC.bucket, probe.key)).body : null;
      if (liveCopy) {
        check(sha256(liveCopy) === sha256(probe.body), 'Spot check: a restored object is byte-identical to the live one', probe.key);
      } else {
        check(true, 'Spot check skipped — the probe object no longer exists in the live bucket', probe.key);
      }
    }
  } finally {
    if (created && process.env.KEEP_DRILL_BUCKET === '1') {
      console.log(`==> KEEP_DRILL_BUCKET=1 — scratch bucket kept: ${scratch}`);
    } else if (created) {
      const leftovers = await listAll(s3, scratch).catch(() => []);
      for (let i = 0; i < leftovers.length; i += 1000) {
        await s3
          .send(new DeleteObjectsCommand({ Bucket: scratch, Delete: { Objects: leftovers.slice(i, i + 1000).map((o) => ({ Key: o.Key })) } }))
          .catch(() => {});
      }
      await s3.send(new DeleteBucketCommand({ Bucket: scratch })).catch((e) => {
        console.error(`${C.yellow}warning:${C.off} could not drop scratch bucket ${scratch}: ${e.message}`);
      });
      console.log(`==> Dropped scratch bucket ${scratch}`);
    }
  }

  console.log();
  console.log('==============================================================');
  console.log(` Object restore drill: ${PASS} passed, ${FAIL} failed`);
  console.log('==============================================================');
  if (FAIL > 0) process.exit(1);
}

const argv = process.argv.slice(2);
if (argv[0] === '--upload') await cmdUpload(argv[1]);
else if (argv[0] === '--list') await cmdList();
else if (argv[0] === '--pull') await cmdPull(argv[1], argv[2]);
else if (argv[0] === '--drill') await cmdDrill(argv[1]);
else if (argv[0] === '-h' || argv[0] === '--help') {
  console.log('usage: node scripts/backup-objects.mjs [--upload [ARCHIVE] | --list | --pull [RUN] [DIR] | --drill [--latest|ARCHIVE]]');
} else if (argv[0]) fail(`unknown argument '${argv[0]}'`);
else await cmdArchive();
