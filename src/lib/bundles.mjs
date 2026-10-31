// Server bundles on disk: /data/bundles/<server>/<tag>/, one directory per installed release.
// The host keeps the running release and the one before it (for rollback) and deletes the rest.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA, run } from './util.mjs';
import { downloadAsset, readChecksum } from './github.mjs';
import { MANIFEST_FILE, normalizeManifest, validateManifest } from './manifest.mjs';

export const BUNDLES = path.join(DATA, 'bundles');
const STAGING = path.join(BUNDLES, '.staging');
const DOWNLOADS = path.join(DATA, 'downloads');
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

const safeTag = (tag) => String(tag).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'release';

/** Read and validate the manifest in an extracted bundle. Throws with every problem listed. */
export function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  if (!existsSync(file)) throw new Error(`the bundle has no ${MANIFEST_FILE} at its root`);
  let m;
  try {
    m = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${MANIFEST_FILE} is not valid JSON: ${err.message}`);
  }
  const errors = validateManifest(m);
  if (errors.length) throw new Error(`${MANIFEST_FILE}: ${errors.join('; ')}`);
  if (m.node && m.node !== NODE_MAJOR) throw new Error(`the bundle was built for Node ${m.node}; this host runs Node ${NODE_MAJOR}`);
  return normalizeManifest(m);
}

/**
 * Download a release's bundle, check it and unpack it into a new directory of its own. `accept`
 * sees the manifest first and throws to refuse the bundle (e.g. an update naming another server).
 * Directory names are unique, so an install never touches a bundle that is in use.
 */
export async function installBundle(release, token, { accept = () => {}, onProgress = () => {} } = {}) {
  mkdirSync(DOWNLOADS, { recursive: true });
  mkdirSync(STAGING, { recursive: true });
  const id = randomUUID();
  const archive = path.join(DOWNLOADS, `${id}.tar.gz`);
  const stage = path.join(STAGING, id);
  try {
    onProgress(`downloading ${release.tag} (${Math.max(1, Math.round(release.asset.size / 1e6))} MB)`);
    const got = await downloadAsset(release.asset, token, archive);
    if (release.checksum) {
      const want = await readChecksum(release.checksum, token);
      if (want !== got.sha256) throw new Error(`checksum mismatch for ${release.tag}: expected ${want}, got ${got.sha256}`);
    }
    onProgress('unpacking');
    mkdirSync(stage);
    const x = await run('tar', ['-xzf', archive, '-C', stage, '--no-same-owner']);
    if (x.code !== 0) throw new Error(`could not unpack the bundle: ${x.output.trim().slice(-300)}`);
    const manifest = readManifest(stage);
    accept(manifest);
    const dir = path.join(BUNDLES, manifest.name, `${safeTag(release.tag)}-${id.slice(0, 8)}`);
    mkdirSync(path.dirname(dir), { recursive: true });
    renameSync(stage, dir);
    return { dir, manifest, tag: release.tag, version: manifest.version || release.tag.replace(/^v/, '') };
  } finally {
    rmSync(archive, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Delete a server's bundle directories other than the ones still referenced. */
export function pruneBundles(name, keep) {
  const root = path.join(BUNDLES, name);
  if (!existsSync(root)) return;
  const wanted = new Set(keep.filter(Boolean).map((d) => path.resolve(d)));
  for (const entry of readdirSync(root)) {
    const dir = path.resolve(root, entry);
    if (!wanted.has(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

export function removeBundles(name) {
  rmSync(path.join(BUNDLES, name), { recursive: true, force: true });
}
