import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DATA = process.env.DATA_DIR || '/data';
export const LOGS = path.join(DATA, 'logs');
mkdirSync(LOGS, { recursive: true });

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write through a temp file so a crash mid-write never leaves half a file. */
export function writeJson(file, value, { mode } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode ? { mode } : undefined);
  renameSync(tmp, file);
  if (mode) chmodSync(file, mode);
}

export function log(scope, msg) {
  console.log(`${new Date().toISOString()} [${scope}] ${msg}`);
}

export function incident(entry) {
  appendFileSync(
    path.join(DATA, 'incidents.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
  );
}

export function recentIncidents(limit = 50) {
  try {
    return readFileSync(path.join(DATA, 'incidents.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .slice(-limit)
      .map((l) => JSON.parse(l))
      .reverse();
  } catch {
    return [];
  }
}

/** Run a program to completion without a shell. Never throws; returns { code, output }. */
export function run(file, args, { cwd, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd });
    let output = '';
    const cap = (d) => {
      output += d;
      if (output.length > 100_000) output = output.slice(-50_000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: output + String(err) });
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE = 64 * 1024;

/** Validate a { set: {NAME: value}, remove: [NAME] } edit of environment variables. */
export function validateEnvEdit(body, reserved = new Set()) {
  const errors = [];
  const set = body?.set ?? {};
  const remove = body?.remove ?? [];
  if (typeof set !== 'object' || set === null || Array.isArray(set)) errors.push('"set" must be an object');
  else
    for (const [k, v] of Object.entries(set)) {
      if (!ENV_NAME_RE.test(k)) errors.push(`name "${k}" is invalid`);
      else if (reserved.has(k)) errors.push(`${k} is set by the host`);
      if (typeof v !== 'string' || v === '') errors.push(`${k} needs a non-empty value`);
      else if (v.length > MAX_VALUE) errors.push(`${k} is too long`);
    }
  if (!Array.isArray(remove) || remove.some((k) => typeof k !== 'string')) errors.push('"remove" must be an array of names');
  return errors;
}
