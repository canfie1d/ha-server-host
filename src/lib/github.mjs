// GitHub Releases: find a repo's latest release and download its server bundle.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API = (process.env.HOST_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const UA = 'ha-server-host';
// The asset each server's CI attaches to a release, with an optional "<asset>.sha256" beside it.
export const BUNDLE_ASSET = 'bundle-linux-x64.tar.gz';
const MAX_BUNDLE_BYTES = 1024 ** 3;

/** "owner/repo" from owner/repo, a github.com URL or a git@github.com address. */
export function parseRepo(input) {
  const s = String(input || '').trim();
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(s);
  if (!m || m[2] === '.' || m[2] === '..') throw new Error('Enter a GitHub repo as owner/repo or its github.com URL');
  return `${m[1]}/${m[2]}`;
}

function headers(token, accept = 'application/vnd.github+json') {
  const h = { accept, 'user-agent': UA, 'x-github-api-version': '2022-11-28' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** The latest published (non-draft, non-prerelease) release and its bundle asset. */
export async function latestRelease(repo, token) {
  const res = await fetch(`${API}/repos/${repo}/releases/latest`, {
    headers: headers(token),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) {
    throw new Error(`No published release found for ${repo}. If the repo is private, check the GitHub token on the Host page.`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`GitHub refused the request for ${repo} (HTTP ${res.status}); check the GitHub token on the Host page`);
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for ${repo}`);
  const r = await res.json();
  const assets = Array.isArray(r.assets) ? r.assets : [];
  const asset = assets.find((a) => a.name === BUNDLE_ASSET);
  if (!asset) throw new Error(`Release ${r.tag_name} of ${repo} has no ${BUNDLE_ASSET} asset`);
  const sum = assets.find((a) => a.name === `${BUNDLE_ASSET}.sha256`);
  const pick = (a) => ({ name: a.name, size: a.size, url: a.url });
  return {
    tag: r.tag_name,
    name: r.name || r.tag_name,
    publishedAt: r.published_at,
    htmlUrl: r.html_url,
    asset: pick(asset),
    checksum: sum ? pick(sum) : null,
  };
}

// Asset API URLs answer with a redirect to storage; fetch drops the Authorization header when the
// redirect leaves the origin, which the storage URL requires.
async function fetchAsset(asset, token, timeoutMs) {
  const res = await fetch(asset.url, {
    headers: headers(token, 'application/octet-stream'),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`download of ${asset.name} failed: HTTP ${res.status}`);
  return res;
}

/** Stream an asset to a file. Returns its sha256 and size. */
export async function downloadAsset(asset, token, dest) {
  const res = await fetchAsset(asset, token, 15 * 60_000);
  const hash = createHash('sha256');
  let size = 0;
  const count = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_BUNDLE_BYTES) return cb(new Error(`${asset.name} is larger than 1 GB`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), count, createWriteStream(dest));
  return { sha256: hash.digest('hex'), size };
}

/** The hex digest from a "<sha256>  <file>" checksum asset. */
export async function readChecksum(asset, token) {
  const res = await fetchAsset(asset, token, 30_000);
  const m = /^[0-9a-f]{64}\b/i.exec((await res.text()).trim());
  if (!m) throw new Error(`${asset.name} does not contain a sha256 digest`);
  return m[0].toLowerCase();
}
