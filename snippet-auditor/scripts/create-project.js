#!/usr/bin/env node
// Creates a project and prints its two private access links.
// Only token HASHES are stored; the raw links are shown once, here.
//
//   npm run create-project -- --name "Checkout flow"                       (random neutral id, e.g. p-7k2m9xq4)
//   npm run create-project -- --id checkout --name "Checkout flow" [--html path/to/file.html]
//   npm run create-project -- --id checkout --rotate dev|qa|both            (issue new links, old ones stop working)
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { loadEnv } from '../lib/env.js';
import { generateToken, hashToken } from '../lib/tokens.js';
import { isProjectId, LIMITS } from '../lib/validate.js';

loadEnv();
const { getStore } = await import('../lib/store/index.js');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
function fail(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }

const rotate = arg('rotate');
// No --id: generate a neutral one so the link doesn't reveal the client or project.
const id = arg('id') || (rotate ? undefined : 'p-' + [...randomBytes(8)].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join(''));
const name = arg('name') || 'Untitled Project';
const htmlPath = arg('html');
const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

if (!isProjectId(id)) fail(rotate ? 'Pass the --id of the project whose links you want to replace.' : 'The --id can only use lowercase letters, numbers and dashes (e.g. --id checkout-flow).');

const store = getStore();
const links = {};

if (rotate) {
  if (!['dev', 'qa', 'both'].includes(rotate)) fail('--rotate must be dev, qa or both.');
  const patch = {};
  if (rotate !== 'qa') { links.dev = generateToken('dev'); patch.devTokenHash = hashToken(links.dev); }
  if (rotate !== 'dev') { links.qa = generateToken('qa'); patch.qaTokenHash = hashToken(links.qa); }
  if (!(await store.setTokenHashes(id, patch))) fail(`No project with id "${id}".`);
  console.log(`\n✔ New ${rotate === 'both' ? 'links' : rotate + ' link'} issued for "${id}". Previous ${rotate === 'both' ? 'links' : 'link'} no longer work.`);
} else {
  if (!name || !name.trim() || name.length > LIMITS.projectName) fail('Pass a --name of 1–120 characters.');
  let html = '';
  if (htmlPath) {
    try { html = await readFile(htmlPath, 'utf8'); } catch { fail(`Could not read ${htmlPath}.`); }
    if (Buffer.byteLength(html) > LIMITS.htmlBytes) fail('HTML is too large (2 MB limit).');
  }
  links.dev = generateToken('dev');
  links.qa = generateToken('qa');
  try {
    await store.createProject({ id, name: name.trim(), html, devTokenHash: hashToken(links.dev), qaTokenHash: hashToken(links.qa) });
  } catch (e) { fail(e.message); }
  console.log(`\n✔ Created project "${name.trim()}" (id: ${id}).`);
}

console.log('\nStore these links in your password manager. They are not saved anywhere and cannot be shown again.\n');
if (links.dev) console.log(`  Developer:  ${base}/project/${id}/dev?token=${links.dev}`);
if (links.qa) console.log(`  Client QA:  ${base}/project/${id}/qa?token=${links.qa}`);
console.log('');
