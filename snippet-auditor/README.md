# Snippet Auditor

HTML prototype editor with two private viewpoints that share one project:

- **Developer view** — edit HTML, Run (local preview only), Save (persists), read QA notes.
- **Client / review view** — see the latest *saved* HTML, add, edit, select and delete QA pointers (autosaved).

No login. Each project has two random access links. The server hashes the token from the link, finds the project, and decides the role. The browser never talks to Supabase directly, and the Supabase secret key only exists on the server.

```
Browser ──► /api/* (token → project → role) ──► Supabase (projects, qa_pointers)
```

## Quick start (no Supabase needed)

Requires Node 18.17+.

```bash
npm install
DATA_DRIVER=file npm run create-project -- --id 30tril --name "30tril Onboarding" --html examples/onboarding.html
DATA_DRIVER=file npm run dev
```

`create-project` prints a developer link and a client link. Open them at http://localhost:3000. The file driver stores data in `.data/db.json` (git-ignored). It is for local development only.

## Connect Supabase

1. Create a Supabase project.
2. In **SQL Editor**, run `supabase/schema.sql`. It is safe to re-run.
3. Copy `.env.example` to `.env.local` and set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (Project Settings → API Keys → secret key, or the legacy `service_role` key).
4. Create the first project and save the two printed links in your password manager:

   ```bash
   npm run create-project -- --id 30tril --name "30tril" --html examples/onboarding.html
   npm run dev
   ```

If a link leaks, issue a new one. The old one stops working immediately:

```bash
npm run create-project -- --id 30tril --rotate qa      # or dev, or both
```

## Project structure

```
api/                     Vercel serverless functions (also run by server.js locally)
  access.js              POST   /api/access
  project.js             GET | PATCH /api/project
  pointers/index.js      GET | POST  /api/pointers
  pointers/[id].js       PATCH | DELETE /api/pointers/:id
lib/
  auth.js                authorizeRequest(): the one place tokens are checked
  tokens.js              crypto-random tokens, SHA-256 hashing, constant-time compare
  validate.js            input limits (name 120, HTML 2 MB, screen name 150, notes 5,000)
  http.js                response envelope, errors, request logging (no tokens)
  store/supabase.js      production data driver
  store/file.js          local data driver (same behaviour)
public/                  static frontend (no build step)
  developer/index.html   developer viewpoint
  client/index.html      client viewpoint (contains no editor, Run or Save)
  assets/                app.css, api.js, editor.js, preview.js, qa-panel.js, developer.js, client.js
scripts/create-project.js
supabase/schema.sql
tests/api.test.js        permission, scoping and data-flow tests
server.js                local dev server
vercel.json              routes /project/:id/dev and /project/:id/qa, security headers
```

The plan suggested top-level `developer/`, `client/` and `shared/` folders. They live under `public/` so that Vercel serves only the frontend and never exposes `lib/` or `api/` source as static files.

## Permissions

| Capability | Developer link | Client link |
|---|:---:|:---:|
| View preview (saved HTML) | ✓ | ✓ |
| View, edit and Run HTML | ✓ | ✗ |
| Save HTML and project title | ✓ | ✗ (403) |
| View QA pointers | ✓ | ✓ |
| Add, edit and delete QA pointers | ✗ (403) | ✓ |

A link opened on the wrong path (a client token on `/dev`) is redirected to the view its token allows.

## API

All responses use `{ success: true, data }` or `{ success: false, error: { code, message } }`.
Send the token as `Authorization: Bearer <token>` and the project as `?projectId=…`.

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/access` | any | Body `{ projectId, token }` → `{ authorized, role, project }` |
| GET | `/api/project` | any | `{ id, name, html, createdAt, updatedAt }` |
| PATCH | `/api/project` | developer | `{ name?, html?, baseUpdatedAt? }`. Returns 409 if someone saved after `baseUpdatedAt` |
| GET | `/api/pointers` | any | `{ pointers, nextPointerNumber }` |
| POST | `/api/pointers` | client | `{ screenName, notes }`. The server assigns `pointerNumber` |
| PATCH | `/api/pointers/:id` | client | `{ screenName?, notes? }`. The pointer must belong to the project |
| DELETE | `/api/pointers/:id` | client | |

Bad, unknown or cross-project tokens all get the same `401` body, so a response never reveals whether a project or token exists.

## Behaviour notes

- **Run never saves.** Save sends the title and HTML in one request, and the Save button is disabled while a save is in flight.
- **Save conflicts.** If the project was saved from another tab or browser since you loaded it, Save stops with "newer version exists" and offers to overwrite.
- **QA autosave.** Notes save 700 ms after typing stops, and also on blur and on Cmd/Ctrl+S. A pointer saves once it has a screen name, and the card says so until then.
- **Stable numbers.** Numbers come from `projects.next_pointer_number`, which only ever increases. Deleted numbers are never reused, even the highest one.
- **Delete confirmation.** Deleting a pointer asks for confirmation first.
- **Refresh in the client view** first saves any pending notes, then loads the latest saved HTML and QA notes without discarding unsaved edits.
- **Preview isolation.** The preview is a sandboxed `srcdoc` iframe without `allow-same-origin`, so prototype code cannot read the page, the token or the API.
- **Referrer-Policy: no-referrer** is set on every page. Without it, a link or image inside a prototype could send the page URL, token included, to another site.
- **Browser storage.** Only UI preferences (viewport, selected pointer, panel) are kept in localStorage. Tokens are never stored or logged.

## Tests

```bash
npm test
```

Runs 14 API tests against the local server with a temporary file database. They cover:

- role per token, and generic 401s
- client-cannot-save (403) and developer-cannot-write-QA (403)
- cross-project scoping
- stable numbering after deletes
- validation limits, and the save-conflict check
- the client page containing no editor

For the manual developer, client and cross-view checks, see sections 78–82 of the implementation plan.

## Deploy (later phase)

1. Push to GitHub without `.env.local`.
2. Import the repo in Vercel and set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in Project Settings → Environment Variables.
3. Set `APP_BASE_URL` locally to the production URL before running `create-project`, so the printed links point there.

## Known limits (MVP)

- Access links are bearer credentials: anyone with a link has that view. Share them privately, and use `--rotate` if one leaks.
- The client view never shows source code, but the browser has to receive the HTML to render it. Someone opening devtools can read the rendered prototype.
- There is no rate limiting on `/api/access`. 256-bit tokens make guessing infeasible, but add rate limiting before any public launch.
- There is no realtime sync. Use Refresh to see the other side's changes.
