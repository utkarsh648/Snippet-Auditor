// End-to-end API tests against the local server using the file driver.
// Covers the permission matrix, token separation, project scoping,
// stable pointer numbering, validation and the save-conflict check.
//   npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'snippet-auditor-'));
process.env.DATA_DRIVER = 'file';
process.env.DATA_FILE = join(dir, 'db.json');
process.env.NODE_ENV = 'test';
delete process.env.SUPABASE_URL;

const { createServer } = await import('../dev-server.js');
const { getStore } = await import('../lib/store/index.js');
const { generateToken, hashToken } = await import('../lib/tokens.js');

let server, base;
const A = { id: 'alpha', dev: generateToken('dev'), qa: generateToken('qa') };
const B = { id: 'beta', dev: generateToken('dev'), qa: generateToken('qa') };

before(async () => {
  for (const p of [A, B]) {
    await getStore().createProject({ id: p.id, name: p.id.toUpperCase(), html: `<h1>${p.id}</h1>`, devTokenHash: hashToken(p.dev), qaTokenHash: hashToken(p.qa) });
  }
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(method, path, { token, body, projectId } = {}) {
  const url = new URL(base + path);
  if (projectId) url.searchParams.set('projectId', projectId);
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('access: each token maps to exactly its own role', async () => {
  const dev = await call('POST', '/api/access', { body: { projectId: A.id, token: A.dev } });
  assert.equal(dev.status, 200);
  assert.equal(dev.json.data.role, 'developer');
  const qa = await call('POST', '/api/access', { body: { projectId: A.id, token: A.qa } });
  assert.equal(qa.json.data.role, 'client');
  assert.equal(qa.json.data.project.html, '<h1>alpha</h1>');
});

test('access: responses never include token hashes', async () => {
  const r = await call('POST', '/api/access', { body: { projectId: A.id, token: A.dev } });
  const text = JSON.stringify(r.json);
  assert.ok(!/hash/i.test(text));
  assert.ok(!text.includes(hashToken(A.dev)));
});

test('access: invalid, malformed, cross-project and missing tokens get the same generic 401', async () => {
  const cases = [
    { projectId: A.id, token: generateToken('dev') },   // well-formed, unknown
    { projectId: A.id, token: 'nope' },                  // malformed
    { projectId: A.id, token: B.dev },                   // valid for another project
    { projectId: 'does-not-exist', token: A.dev },       // unknown project
    { projectId: A.id }                                  // missing
  ];
  const bodies = new Set();
  for (const body of cases) {
    const r = await call('POST', '/api/access', { body });
    assert.equal(r.status, 401);
    bodies.add(JSON.stringify(r.json));
  }
  assert.equal(bodies.size, 1, 'error responses must not reveal which part was wrong');
});

test('project: client token cannot update HTML (403)', async () => {
  const r = await call('PATCH', '/api/project', { token: A.qa, projectId: A.id, body: { html: '<p>hacked</p>' } });
  assert.equal(r.status, 403);
  const p = await call('GET', '/api/project', { token: A.qa, projectId: A.id });
  assert.equal(p.json.data.html, '<h1>alpha</h1>');
});

test('project: developer saves; client sees the saved HTML', async () => {
  const before = await call('GET', '/api/project', { token: A.dev, projectId: A.id });
  const r = await call('PATCH', '/api/project', { token: A.dev, projectId: A.id, body: { name: 'Alpha v2', html: '<h1>v2</h1>', baseUpdatedAt: before.json.data.updatedAt } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.name, 'Alpha v2');
  const c = await call('GET', '/api/project', { token: A.qa, projectId: A.id });
  assert.equal(c.json.data.html, '<h1>v2</h1>');
});

test('project: stale baseUpdatedAt is rejected with 409', async () => {
  const r = await call('PATCH', '/api/project', { token: A.dev, projectId: A.id, body: { html: '<h1>old tab</h1>', baseUpdatedAt: '2000-01-01T00:00:00.000Z' } });
  assert.equal(r.status, 409);
});

test('project: validation (empty name, non-string html, oversize html)', async () => {
  assert.equal((await call('PATCH', '/api/project', { token: A.dev, projectId: A.id, body: { name: '   ' } })).status, 400);
  assert.equal((await call('PATCH', '/api/project', { token: A.dev, projectId: A.id, body: { html: 42 } })).status, 400);
  assert.equal((await call('PATCH', '/api/project', { token: A.dev, projectId: A.id, body: {} })).status, 400);
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  assert.equal((await call('PATCH', '/api/project', { token: A.dev, projectId: A.id, body: { html: big } })).status, 413);
});

test('pointers: developer token cannot create, edit or delete QA (403)', async () => {
  assert.equal((await call('POST', '/api/pointers', { token: A.dev, projectId: A.id, body: { screenName: 'x' } })).status, 403);
});

test('pointers: numbers are assigned by the server and never reused', async () => {
  const mk = (screenName) => call('POST', '/api/pointers', { token: A.qa, projectId: A.id, body: { screenName, notes: '', pointerNumber: 99 } });
  const p1 = (await mk('Household')).json.data.pointer;
  const p2 = (await mk('Connections')).json.data.pointer;
  const p3 = (await mk('Preferences')).json.data.pointer;
  assert.deepEqual([p1.pointerNumber, p2.pointerNumber, p3.pointerNumber], [1, 2, 3]);

  assert.equal((await call('DELETE', `/api/pointers/${p3.id}`, { token: A.qa, projectId: A.id })).status, 200);
  const p4 = (await mk('Done')).json.data.pointer;
  assert.equal(p4.pointerNumber, 4, 'deleting the highest number must not free it for reuse');

  assert.equal((await call('DELETE', `/api/pointers/${p2.id}`, { token: A.qa, projectId: A.id })).status, 200);
  const list = await call('GET', '/api/pointers', { token: A.dev, projectId: A.id });
  assert.deepEqual(list.json.data.pointers.map((p) => p.pointerNumber), [1, 4]);
  assert.equal(list.json.data.nextPointerNumber, 5);
});

test('pointers: edit persists; developer can read it', async () => {
  const p = (await call('POST', '/api/pointers', { token: A.qa, projectId: A.id, body: { screenName: 'Edit me', notes: 'a' } })).json.data.pointer;
  const r = await call('PATCH', `/api/pointers/${p.id}`, { token: A.qa, projectId: A.id, body: { notes: 'Household selection should be easier to understand.' } });
  assert.equal(r.status, 200);
  const list = await call('GET', '/api/pointers', { token: A.dev, projectId: A.id });
  assert.equal(list.json.data.pointers.find((x) => x.id === p.id).notes, 'Household selection should be easier to understand.');
  assert.equal((await call('PATCH', `/api/pointers/${p.id}`, { token: A.dev, projectId: A.id, body: { notes: 'dev edit' } })).status, 403);
  assert.equal((await call('DELETE', `/api/pointers/${p.id}`, { token: A.dev, projectId: A.id })).status, 403);
});

test('pointers: scoped to the project; another project cannot touch them', async () => {
  const p = (await call('POST', '/api/pointers', { token: A.qa, projectId: A.id, body: { screenName: 'Private to alpha' } })).json.data.pointer;
  // Beta's valid review token, pointed at Alpha's pointer id.
  assert.equal((await call('PATCH', `/api/pointers/${p.id}`, { token: B.qa, projectId: B.id, body: { notes: 'x' } })).status, 404);
  assert.equal((await call('DELETE', `/api/pointers/${p.id}`, { token: B.qa, projectId: B.id })).status, 404);
  // Beta's token claiming to be Alpha.
  assert.equal((await call('DELETE', `/api/pointers/${p.id}`, { token: B.qa, projectId: A.id })).status, 401);
  const betaList = await call('GET', '/api/pointers', { token: B.qa, projectId: B.id });
  assert.equal(betaList.json.data.pointers.length, 0);
});

test('pointers: validation limits', async () => {
  const post = (body) => call('POST', '/api/pointers', { token: A.qa, projectId: A.id, body });
  assert.equal((await post({ screenName: '' })).status, 400);
  assert.equal((await post({ screenName: 'x'.repeat(151) })).status, 400);
  assert.equal((await post({ screenName: 'ok', notes: 'x'.repeat(5001) })).status, 400);
  assert.equal((await post({ screenName: 'ok', notes: 5 })).status, 400);
  assert.equal((await call('PATCH', '/api/pointers/not-a-uuid', { token: A.qa, projectId: A.id, body: { notes: 'x' } })).status, 404);
});

test('api: consistent envelope and method handling', async () => {
  const r = await call('PUT', '/api/project', { token: A.dev, projectId: A.id, body: {} });
  assert.equal(r.status, 405);
  assert.equal(r.json.success, false);
  assert.ok(r.json.error.code && r.json.error.message);
  const ok = await call('GET', '/api/pointers', { token: A.qa, projectId: A.id });
  assert.equal(ok.json.success, true);
});

test('routes: viewpoints are served; static files cannot escape /public', async () => {
  const dev = await fetch(`${base}/project/alpha/dev?token=x`);
  assert.equal(dev.status, 200);
  assert.ok((await dev.text()).includes('/assets/developer.js'));
  const qa = await fetch(`${base}/project/alpha/qa?token=x`);
  assert.ok((await qa.text()).includes('/assets/client.js'));
  assert.ok(!(await (await fetch(`${base}/project/alpha/qa`)).text()).includes('id="source"'), 'client page must not contain the code editor');
  const esc = await fetch(`${base}/%2e%2e/package.json`);
  assert.notEqual(esc.status, 200);
});
