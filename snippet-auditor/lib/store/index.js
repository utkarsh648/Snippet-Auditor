// Picks the data driver. Production uses Supabase; local development can
// use a JSON file so the app runs before Supabase is set up.
import { createSupabaseStore } from './supabase.js';
import { createFileStore } from './file.js';

let store = null;

export function getStore() {
  if (store) return store;
  const driver = (process.env.DATA_DRIVER || (process.env.SUPABASE_URL ? 'supabase' : 'file')).toLowerCase();
  if (driver === 'supabase') {
    store = createSupabaseStore({ url: process.env.SUPABASE_URL, secretKey: process.env.SUPABASE_SECRET_KEY });
  } else if (driver === 'file') {
    if (process.env.VERCEL) throw new Error('DATA_DRIVER=file cannot run on Vercel. Set SUPABASE_URL and SUPABASE_SECRET_KEY.');
    store = createFileStore({ path: process.env.DATA_FILE || '.data/db.json' });
  } else {
    throw new Error(`Unknown DATA_DRIVER "${driver}". Use "supabase" or "file".`);
  }
  return store;
}

// For tests.
export function setStore(s) { store = s; }

/*
Store interface (both drivers implement it):

  getProjectWithHashes(id)                    → project incl. devTokenHash/qaTokenHash, or null
  createProject({ id, name, html, devTokenHash, qaTokenHash }) → project
  setTokenHashes(id, { devTokenHash, qaTokenHash })             → boolean
  updateProject(id, { name?, html? }, baseUpdatedAt?)           → project | 'conflict' | null
  listPointers(projectId)                     → { pointers, nextPointerNumber }
  createPointer(projectId, { screenName, notes })               → pointer (number assigned atomically)
  updatePointer(projectId, pointerId, { screenName?, notes? })   → pointer | null
  deletePointer(projectId, pointerId)         → boolean

Project:  { id, name, html, createdAt, updatedAt }
Pointer:  { id, pointerNumber, screenName, notes, createdAt, updatedAt }
*/
