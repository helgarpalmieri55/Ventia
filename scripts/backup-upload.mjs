#!/usr/bin/env node
// Offsite half of SPEC.md §10: "nightly `pg_dump` to R2 (30-day retention)".
//
// `scripts/backup.sh` produces four files on the machine that ran it. That is
// not yet a backup — a backup that lives only on the host it protects is lost
// in exactly the incident it exists for (disk failure, a reclaimed container,
// a `rm -rf` in the wrong directory). This script is what makes it one: it
// copies a backup run offsite and, crucially, VERIFIES the copy by reading it
// back rather than trusting the PUT's own 200.
//
// S3-compatible, not R2-specific. Cloudflare R2 is the intended production
// target (SPEC.md §10), but it speaks S3, and so does the MinIO already in
// docker/compose.yaml — which is how this script was actually exercised. The
// only R2-specific thing anywhere is the endpoint URL you configure.
//
// WHY THE SDK AND NOT `aws s3 cp`: no S3 CLI is installed on the API host and
// adding one is a second thing to provision; `@aws-sdk/client-s3` is already a
// dependency of services/api (the product-image storage service uses it), so
// this costs nothing new. `forcePathStyle: true` and `region: 'auto'` mirror
// services/api/src/storage/storage.service.ts exactly — both are required for
// MinIO and correct for R2.
//
// Usage:
//   node scripts/backup-upload.mjs                     # upload the newest run in BACKUP_DIR
//   node scripts/backup-upload.mjs /path/to/base.dump  # upload a specific run
//   node scripts/backup-upload.mjs --list              # what is offsite right now
//   node scripts/backup-upload.mjs --pull [RUN] [DIR]  # bring a run back down
//
// `--pull` is not a convenience. An offsite backup nobody has ever fetched is
// an assumption, not a backup, and the failure modes it hides (wrong bucket,
// wrong prefix, credentials that can PUT but not GET, an object stored but
// unreadable) all present as "everything looks fine" until the incident. It
// downloads a run, checks each file against the manifest's own `.sha256`, and
// leaves it somewhere `scripts/restore-drill.sh --backup` can be pointed at —
// so the offsite copy can be drilled exactly like a local one. With no RUN it
// pulls the newest run offsite.
//
// Env (all required except the optional ones marked):
//   BACKUP_S3_ENDPOINT     e.g. https://<account>.r2.cloudflarestorage.com
//   BACKUP_S3_BUCKET       e.g. ventia-backups
//   BACKUP_S3_ACCESS_KEY
//   BACKUP_S3_SECRET_KEY
//   BACKUP_S3_PREFIX       optional, default "postgres/" — key prefix inside the bucket
//   BACKUP_DIR             optional, default ${TMPDIR:-/tmp}/ventia-backups
//   BACKUP_RETENTION_DAYS  optional, default 30 — prunes OFFSITE copies too
//
// Exit codes: 0 all four files uploaded and verified; 1 anything else. There is
// deliberately no partial-success exit code: three of four files offsite is a
// failed backup, because a dump without its globals restores into a cluster
// with tenant isolation switched off (see docs/operations.md).

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const C = { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };
const fail = (msg) => {
  console.error(`${C.red}error:${C.off} ${msg}`);
  process.exit(1);
};

const ENDPOINT = process.env.BACKUP_S3_ENDPOINT;
const BUCKET = process.env.BACKUP_S3_BUCKET;
const ACCESS_KEY = process.env.BACKUP_S3_ACCESS_KEY;
const SECRET_KEY = process.env.BACKUP_S3_SECRET_KEY;
const PREFIX = process.env.BACKUP_S3_PREFIX ?? 'postgres/';
const BACKUP_DIR = process.env.BACKUP_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'ventia-backups');
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);

for (const [name, value] of [
  ['BACKUP_S3_ENDPOINT', ENDPOINT],
  ['BACKUP_S3_BUCKET', BUCKET],
  ['BACKUP_S3_ACCESS_KEY', ACCESS_KEY],
  ['BACKUP_S3_SECRET_KEY', SECRET_KEY],
]) {
  if (!value) fail(`${name} is not set. Offsite upload is configured entirely through the environment; see docs/operations.md.`);
}
if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS < 0) {
  fail(`BACKUP_RETENTION_DAYS must be a non-negative number, got ${process.env.BACKUP_RETENTION_DAYS}`);
}

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: 'auto',
  forcePathStyle: true,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

/** Resolves which backup run to upload: the argument if given, else the newest
 * `.dump` in BACKUP_DIR. Newest by mtime rather than by filename: the names are
 * timestamped and would sort correctly, but mtime is the thing that is actually
 * true, and a hand-copied file with an older name is still the newer backup. */
async function resolveRun(arg) {
  if (arg) {
    if (!arg.endsWith('.dump')) fail(`expected a path ending in .dump, got ${arg}`);
    await stat(arg).catch(() => fail(`no such file: ${arg}`));
    return arg;
  }
  const entries = await readdir(BACKUP_DIR).catch(() =>
    fail(`BACKUP_DIR does not exist: ${BACKUP_DIR}. Run scripts/backup.sh first.`),
  );
  const dumps = entries.filter((f) => f.startsWith('ventia-') && f.endsWith('.dump'));
  if (dumps.length === 0) fail(`no ventia-*.dump files in ${BACKUP_DIR}. Run scripts/backup.sh first.`);
  const withTimes = await Promise.all(
    dumps.map(async (f) => ({ f, mtime: (await stat(join(BACKUP_DIR, f))).mtimeMs })),
  );
  withTimes.sort((a, b) => b.mtime - a.mtime);
  return join(BACKUP_DIR, withTimes[0].f);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Streams an object back out of the bucket and returns its sha256.
 *
 * This is the point of the whole script. A `PutObject` that returns 200 has
 * told you the request was accepted, not that the bytes that landed are the
 * bytes you sent — and a silently-truncated backup is indistinguishable from a
 * good one until the day you need it. Reading it back and hashing it is the
 * only check that actually answers "is my backup intact offsite". */
async function sha256Object(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const hash = createHash('sha256');
  for await (const chunk of res.Body) hash.update(chunk);
  return hash.digest('hex');
}

/** Every `${PREFIX}ventia-*` key in the bucket, newest run first. */
async function listOffsite() {
  const objects = [];
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}ventia-`, ContinuationToken: token }),
    );
    objects.push(...(page.Contents ?? []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  // Group the four files back into runs by their shared basename.
  const runs = new Map();
  for (const obj of objects) {
    const name = obj.Key.slice(PREFIX.length);
    const run = name.replace(/\.(dump|globals\.sql|manifest\.json|sha256)$/, '');
    if (!runs.has(run)) runs.set(run, { run, files: [], bytes: 0, lastModified: obj.LastModified });
    const entry = runs.get(run);
    entry.files.push(name);
    entry.bytes += obj.Size ?? 0;
    if (obj.LastModified > entry.lastModified) entry.lastModified = obj.LastModified;
  }
  return [...runs.values()].sort((a, b) => b.lastModified - a.lastModified);
}

async function cmdList() {
  const runs = await listOffsite();
  if (runs.length === 0) {
    console.log(`No ventia-* runs under ${ENDPOINT}/${BUCKET}/${PREFIX}`);
    return;
  }
  console.log(`${C.bold}${runs.length} run(s) offsite${C.off} at ${ENDPOINT}/${BUCKET}/${PREFIX}`);
  for (const r of runs) {
    // A run missing any of its four files is called out rather than listed as
    // if it were whole — see the note on why all four matter.
    const complete = r.files.length === 4;
    const mark = complete ? `${C.green}4/4${C.off}` : `${C.yellow}${r.files.length}/4${C.off}`;
    console.log(`  ${mark}  ${r.run}  ${String(r.bytes).padStart(10)} bytes  ${C.dim}${r.lastModified.toISOString()}${C.off}`);
  }
}

async function cmdPull(runArg, destArg) {
  const runs = await listOffsite();
  if (runs.length === 0) fail(`nothing to pull: no ventia-* runs under ${ENDPOINT}/${BUCKET}/${PREFIX}`);
  const run = runArg ? runs.find((r) => r.run === runArg) : runs[0];
  if (!run) fail(`no such run offsite: ${runArg}. Try --list.`);
  if (run.files.length !== 4) {
    fail(`run ${run.run} is incomplete offsite (${run.files.length}/4 files) and must not be restored as if it were whole`);
  }

  const dest = destArg ?? join(BACKUP_DIR, 'pulled');
  await mkdir(dest, { recursive: true });
  console.log(`${C.bold}Pulling${C.off} ${run.run}`);
  console.log(`  ${C.dim}to${C.off}  ${dest}`);

  for (const name of ['.dump', '.globals.sql', '.manifest.json', '.sha256'].map((e) => `${run.run}${e}`)) {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}${name}` }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    await writeFile(join(dest, name), Buffer.concat(chunks));
  }

  // Verify against the run's OWN `.sha256`, which backup.sh wrote before the
  // upload ever happened — so this checks the whole round trip (dump -> PUT ->
  // GET -> disk), not just that two things this script computed agree.
  const expected = new Map(
    (await readFile(join(dest, `${run.run}.sha256`), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [digest, name] = line.replace(/^\\/, '').split(/\s+\*?/);
        return [name, digest];
      }),
  );
  let verified = 0;
  for (const [name, digest] of expected) {
    const actual = await sha256File(join(dest, name));
    if (actual !== digest) {
      fail(`${name} does NOT match the sha256 recorded at backup time — expected ${digest}, got ${actual}. The offsite copy is not usable.`);
    }
    console.log(`  ${C.green}OK${C.off}   ${name.padEnd(42)} ${C.dim}matches backup-time sha256${C.off}`);
    verified += 1;
  }
  if (verified !== 3) fail(`expected 3 checksummed files, verified ${verified}`);

  console.log(`${C.green}Pulled and verified${C.off} — drill it with:`);
  console.log(`  bash scripts/restore-drill.sh --backup ${join(dest, `${run.run}.dump`)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--list') return cmdList();
  if (argv[0] === '--pull') return cmdPull(argv[1], argv[2]);

  const dumpPath = await resolveRun(argv[0]);
  const base = dumpPath.slice(0, -'.dump'.length);
  const dir = dirname(dumpPath);
  const runName = basename(base);

  // All four, or it is not a backup. `.globals.sql` carries the `ventia_app`
  // role every RLS policy is written against; `.manifest.json` is what the
  // restore drill compares against; `.sha256` is how you know the other three
  // survived the trip.
  const files = ['.dump', '.globals.sql', '.manifest.json', '.sha256'].map((ext) => `${base}${ext}`);
  for (const f of files) {
    await stat(f).catch(() => fail(`missing ${basename(f)} — an incomplete backup run must not be uploaded as if it were whole`));
  }

  console.log(`${C.bold}Uploading backup run${C.off} ${runName}`);
  console.log(`  ${C.dim}from${C.off}      ${dir}`);
  console.log(`  ${C.dim}to${C.off}        ${ENDPOINT}/${BUCKET}/${PREFIX}${runName}.*`);

  let uploaded = 0;
  for (const path of files) {
    const key = `${PREFIX}${basename(path)}`;
    const localDigest = await sha256File(path);
    const size = (await stat(path)).size;

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: await readFile(path),
        ContentType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        // Round-trips as object metadata so an operator staring at a bucket
        // can check integrity without this script.
        Metadata: { sha256: localDigest },
      }),
    );

    const remoteDigest = await sha256Object(key);
    if (remoteDigest !== localDigest) {
      fail(`${basename(path)} read back with a DIFFERENT sha256 — local ${localDigest}, remote ${remoteDigest}. The offsite copy is corrupt; do not treat this run as backed up.`);
    }
    console.log(`  ${C.green}OK${C.off}   ${basename(path).padEnd(42)} ${String(size).padStart(10)} bytes  ${C.dim}sha256 verified by read-back${C.off}`);
    uploaded += 1;
  }

  if (uploaded !== 4) fail(`expected 4 files, uploaded ${uploaded}`);

  if (RETENTION_DAYS > 0) {
    // Offsite retention, matching the local pruning in backup.sh. Scoped to
    // this script's own `${PREFIX}ventia-*` keys for the same reason: a bucket
    // may hold other things, and a backup script that deletes a bystander's
    // objects is worse than one that keeps too much.
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const stale = [];
    let token;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}ventia-`, ContinuationToken: token }),
      );
      for (const obj of page.Contents ?? []) {
        if (obj.LastModified && obj.LastModified.getTime() < cutoff) stale.push({ Key: obj.Key });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    if (stale.length > 0) {
      // DeleteObjects caps at 1000 keys per request.
      for (let i = 0; i < stale.length; i += 1000) {
        await s3.send(
          new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: stale.slice(i, i + 1000) } }),
        );
      }
      console.log(`  ${C.dim}pruned ${stale.length} offsite object(s) older than ${RETENTION_DAYS} days${C.off}`);
    }
  }

  console.log(`${C.green}Offsite backup OK${C.off} — 4/4 files uploaded and verified by read-back.`);
}

await main();
