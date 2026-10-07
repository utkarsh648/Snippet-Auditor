// Local-development driver: a JSON file on disk. Mirrors the Supabase
// driver's behaviour (stable pointer numbers, updated_at, conflict check).
// Not for production: no concurrency across processes.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createFileStore({ path }) {
  const file = resolve(path);
  let queue = Promise.resolve();
  let lastStamp = 0;

  // Strictly increasing timestamps so conflict checks never collide.
  function now() {
    let t = Date.now();
    if (t <= lastStamp) t = lastStamp + 1;
    lastStamp = t;
    return new Date(t).toISOString();
  }

  async function load() {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return { projects: {}, pointers: [] }; throw e; }
  }
  async function persist(db) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, file);
  }
  // Serialize every operation so read-modify-write is safe within the process.
  function tx(fn, write = true) {
    const run = queue.then(async () => {
      const db = await load();
      const out = await fn(db);
      if (write) await persist(db);
      return out;
    });
    queue = run.catch(() => {});
    return run;
  }

  const pub = (p) => p && ({ id: p.id, name: p.name, html: p.html, createdAt: p.createdAt, updatedAt: p.updatedAt });
  const ANNOTATION_DEFAULTS = {
    screenState: 'Default', targetType: 'screen', targetSelector: null, targetLabel: null,
    anchorX: null, anchorY: null, viewportWidth: null, viewportHeight: null
  };
  const FIELDS = ['screenName', 'notes', ...Object.keys(ANNOTATION_DEFAULTS)];
  // Older rows (before visual annotations) read back as screen-level notes.
  const ptr = (p) => p && ({
    id: p.id, pointerNumber: p.pointerNumber, screenName: p.screenName, notes: p.notes,
    ...Object.fromEntries(Object.keys(ANNOTATION_DEFAULTS).map((k) => [k, p[k] ?? ANNOTATION_DEFAULTS[k]])),
    createdAt: p.createdAt, updatedAt: p.updatedAt
  });

  return {
    getProjectWithHashes: (id) => tx((db) => {
      const p = db.projects[id];
      return p ? { ...pub(p), devTokenHash: p.devTokenHash, qaTokenHash: p.qaTokenHash } : null;
    }, false),

    createProject: ({ id, name, html, devTokenHash, qaTokenHash }) => tx((db) => {
      if (db.projects[id]) throw new Error(`A project with id "${id}" already exists.`);
      const t = now();
      db.projects[id] = { id, name, html: html || '', devTokenHash, qaTokenHash, nextPointerNumber: 1, createdAt: t, updatedAt: t };
      return pub(db.projects[id]);
    }),

    setTokenHashes: (id, { devTokenHash, qaTokenHash }) => tx((db) => {
      const p = db.projects[id];
      if (!p) return false;
      if (devTokenHash) p.devTokenHash = devTokenHash;
      if (qaTokenHash) p.qaTokenHash = qaTokenHash;
      return true;
    }),

    updateProject: (id, patch, baseUpdatedAt) => tx((db) => {
      const p = db.projects[id];
      if (!p) return null;
      if (baseUpdatedAt && p.updatedAt !== baseUpdatedAt) return 'conflict';
      if (patch.name !== undefined) p.name = patch.name;
      if (patch.html !== undefined) p.html = patch.html;
      p.updatedAt = now();
      return pub(p);
    }),

    listPointers: (projectId) => tx((db) => {
      const p = db.projects[projectId];
      const pointers = db.pointers.filter((x) => x.projectId === projectId)
        .sort((a, b) => a.pointerNumber - b.pointerNumber).map(ptr);
      return { pointers, nextPointerNumber: p ? p.nextPointerNumber : 1 };
    }, false),

    createPointer: (projectId, fields) => tx((db) => {
      const p = db.projects[projectId];
      if (!p) throw new Error('Project not found.');
      const t = now();
      const row = { id: randomUUID(), projectId, pointerNumber: p.nextPointerNumber++, ...ANNOTATION_DEFAULTS, createdAt: t, updatedAt: t };
      for (const k of FIELDS) if (fields[k] !== undefined) row[k] = fields[k];
      db.pointers.push(row);
      return ptr(row);
    }),

    updatePointer: (projectId, pointerId, patch) => tx((db) => {
      const row = db.pointers.find((x) => x.id === pointerId && x.projectId === projectId);
      if (!row) return null;
      for (const k of FIELDS) if (patch[k] !== undefined) row[k] = patch[k];
      row.updatedAt = now();
      return ptr(row);
    }),

    deletePointer: (projectId, pointerId) => tx((db) => {
      const i = db.pointers.findIndex((x) => x.id === pointerId && x.projectId === projectId);
      if (i < 0) return false;
      db.pointers.splice(i, 1);
      return true;
    })
  };
}
