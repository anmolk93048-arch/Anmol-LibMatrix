# Anmol LibMatrix

```
anmol-libmatrix/
├─ netlify.toml            Netlify: publish = frontend
├─ render.yaml             Render blueprint (rootDir = backend)
├─ frontend/               → Netlify
│  ├─ index.html           landing page ( / )
│  ├─ Admin_Login.html  Agent_Login.html  PFMS_login.html
│  ├─ HRMS_login.html   Student_Attendance.html  INVOICE_LOGIN.html
│  ├─ config.js            API_BASE (Render URL) – edit here only
│  ├─ portal-shell.js/.css shared logout, role modal, footer, attendance sync
│  └─ anmol_libmatrix_logo.png   (PLACEHOLDER – replace with your real logo)
└─ backend/                → Render
   ├─ server.js            your original server + 5 small patches
   ├─ supabase-portals.js  supabase-js layer
   ├─ supabase_schema.sql  run once in Supabase SQL Editor
   ├─ package.json  .env.example
```

## 1. Supabase
SQL Editor → paste `backend/supabase_schema.sql` → Run.
Project Settings → API → copy **Project URL** and the **service_role** key.

## 2. GitHub
```bash
cd anmol-libmatrix
git init && git add . && git commit -m "Anmol LibMatrix: frontend + backend + Supabase"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
Replace `frontend/anmol_libmatrix_logo.png` with your real logo first. `.env` is git-ignored.

## 3. Render (backend)
New → Web Service → connect repo → **Root Directory `backend`**, Build `npm install`, Start `npm start`.
Environment: `SUPABASE_URL`, `SUPABASE_KEY` (service_role), `DATABASE_URL`, `JWT_SECRET`,
`PII_ENCRYPTION_KEY`, `FRONTEND_URL` (your Netlify URL). See `backend/.env.example`.
Check `https://<render-url>/api/health` and `/api/portal/health`.

## 4. Netlify (frontend)
Add new site → Import from GitHub → build command empty, publish dir `frontend` (netlify.toml sets it).
If your Render URL differs from `library-backend-4efk.onrender.com`, edit `frontend/config.js`.

## 5. Admin login / reset (Supabase SQL Editor)
Run `backend/supabase_admin_seed.sql` (block A) to create/reset the Super Admin:
**Username `Anmol` / Password `Anmol@2003`** — change it right after logging in.
Or from a terminal: `cd backend && node scripts/reset-admin.js <username> <new-password>` (needs DATABASE_URL).

## 6. Live index
`frontend/index.html` is your original design. Anything saved in Admin (Login & App Access, Homepage,
Navigation, Live Index control…) appears on it within ~15 s — no Netlify redeploy. Portal links open in a new tab.

## 7. If the Admin login says "Server … se connect nahi ho paya"
1. Open `https://<your-render-url>/api/health` — it must return JSON. Render free plan sleeps; the login now retries 4× (≈1–2 min) and shows progress.
2. The backend URL used by every page is `frontend/config.js` → `API_BASE`. It must be your Render URL + `/api`.
3. CORS: any `https://*.netlify.app` site is allowed by default; for a custom domain set `FRONTEND_URL` (or `EXTRA_CORS_ORIGINS`) in Render. `CORS_STRICT=true` limits to those only.
