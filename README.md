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
If your Render URL changes, edit `frontend/config.js` (currently https://anmol-libmatrix.onrender.com/api).

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


## 8. Secure access gate, identity check & Live Index Manager (v3)

**Login flow:** `Admin_Login.html` (username + password + captcha) -> popup *"SECURE ANMOL LibMatrix ACCESS - Welcome Mr./Mrs. <name>"* -> choose Role + Location -> server issues a routing token (`POST /api/portal/route`) -> browser opens `Super_Admin_Dashboard.html`, `PFMS_login.html`, `Agent_Login.html` ... **already signed in**, no second password.
- The popup text, roles, locations, names (Mr./Mrs.) and target pages are edited in **Super Admin -> System & Security -> Role & Location Manager** (stored server-side as private key `access_gate`).
- For an *Agent Login* role, enter the agent username this person should open (e.g. `agent1`); for *HRMS* an Employee ID (e.g. `EMP001`). Without a mapping HRMS/Student/Invoice just open their normal login page.
- PFMS is no longer on the public `index.html` menu; it is reachable only through this gate.

**Identity Number (Aadhaar / ID):** mandatory in Student, Staff (Agent portal + Admin), Agent and HRMS self-registration forms. Before saving, the server checks every student/staff/agent/HRMS/pending record and the encrypted KYC vault; a duplicate returns HTTP 409 with *"This Identity Number is already registered with Agent/Library: [Agent Name/ID]. Please get it deleted from there first."* Live check: `POST /api/identity/check`. Set `IDENTITY_REQUIRED=false` on Render only while importing old data.

**Search:** `GET /api/search/global?q=` - Super Admin sees everything (profile, connected agent, status); an Agent only sees records under their own Agent ID. The top-bar search in the Super Admin panel uses it (Identity Number, name, mobile or ID).

**Live Index Manager** (Super Admin -> Website / Index Control): Home, About, Tickers, Notices, Theme (colours/font), App Downloads, Login Menu, Footer, Dashboard cards, Gallery. Saved through `PUT /api/admin/cms/:key` into Supabase `kv_site_data`; `index.html` polls and updates within seconds - **no Netlify redeploy**.

New backend endpoints: `/api/auth/me`, `/api/gate/config`, `/api/admin/gate-config`, `/api/admin/gate-users`, `/api/portal/route`, `/api/identity/check`, `/api/search/global`, `/api/admin/cms`, `/api/admin/cms/:key`. No new SQL is needed.

## Release notes: English standardization and application tracking

- All user-facing messages (toasts, alerts, modals, API errors) are in professional English. Standard messages:
  invalid password, invalid captcha, user not registered, attendance recorded, application approved, duplicate identity, subscription expired.
- No new sidebars, tabs or menu items were added. The Role & Location Manager lives inside the existing Control Access page; the Live Index Manager opens from the existing Website / Index Control buttons.
- Customer Registration (Agent Portal) has an inline **Track Application Status** toggle (Application ID + mobile number, `POST /api/track-status`). After Super Admin approval the generated User ID and password are shown on that screen (stored encrypted, available for 7 days / 5 views).
- Super Admin approval/rejection of self-registered customers is recorded on the server (`POST /api/admin/customer-registrations/:id/decision`); pending applications are merged into the existing Pending Registrations screen.
- `GET /api/library-branding/:agentId` returns the library name used on payment links and receipts.
- Master admin seed: when no admin exists, `Anmol / Anmol@2003` is created at startup (override with `MASTER_ADMIN_USERNAME` / `MASTER_ADMIN_PASSWORD`). Change the password after the first login.
- Deploy `server.js` together with `supabase-portals.js`.

## Release: Government-style portal shell
- New shared `gov-shell.js/css`: accessibility top bar, branded header (no search), bilingual heading, ownership footer, live announcement ticker, OTP countdown (`AnmolOtp`), shared recovery dialog (`AnmolRecovery`).
- Super Admin → Settings → *Website Notices & Navigation* → **Header & Announcement Settings**: edit ticker text + clickable links; saved via `PUT /api/admin/announcements` and shown on all login pages instantly.
- Login flows: silent cold-start retries, "Authenticating..." spinner, "Login Successful! Redirecting...", exact validation dictionary.
- OTPs: 4-digit, 60s validity, "Resend OTP in Ns" countdown; sent via the configured SMS gateway (Super Admin SMS API config or env `SMS_API_URL` / `SMS_API_KEY`). Agent credentials SMS is sent automatically on create/approve.
- Deploy `backend/server.js` together with `backend/supabase-portals.js`.

## Clean URLs (no `.html`)
`/admin-login`, `/agent-login`, `/hrms-login`, `/student-login`, `/pfms-login`, `/invoice-login`, `/admin-dashboard`.
- Express (`server.js`): `CLEAN_PAGES` table serves each page, 301-redirects every old `*.html` / alias URL to the clean one, and `/api/pages/<slug>` falls back to the built-in page (no more 404).
- Netlify: `frontend/_redirects` provides the same rules. Pages also strip `.html` from the address bar via `history.replaceState`.
- There is ONE admin login (`/admin-login`) — the former "Super Admin Login" aliases redirect to it.

## New in this release
- **Dynamic branding** – `GET /api/branding/agent?u=<username|agentId>`; login pages show the agent's company name + logo (`?agent=<username>` or when the username is typed); the Agent dashboard header uses the uploaded company logo. Default header: "Anmol LibMatrix / Private Limited".
- **Master Users & Registrations** (Super Admin → sidebar) – `GET /api/admin/master-list`, `PUT|DELETE /api/admin/master/:source/:id` (edit, delete, Agent↔Staff/Student mapping), global Aadhaar search with edit/delete. Duplicate Aadhaar on registration now names the existing record and its agent/company.
- **Registration fees** – Super Admin sets default Agent/HRMS fees and custom per-mobile / per-agent fees (₹0 = free): `GET|PUT /api/admin/fee-config`. Paid registrations use Razorpay (`POST /api/registration/payment-order`, signature verified server-side; free ones skip payment). Customer registration supports free orders (`FREE_…` order ids).
- **Tracking IDs** – Agent and HRMS registrations return `TRK-…`; `POST /api/track-status` accepts it with the mobile number and shows approval status and User/Employee ID.
- New accounts (admins/agents/staff/students) default to `status: "active"`.
