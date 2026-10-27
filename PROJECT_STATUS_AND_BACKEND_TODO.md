# Anmol LibMatrix frontend patch — 2026-10-27

## Applied in this package
- Compact, responsive shared login header: “Anmol LibMatrix” with “Private Limited” beneath it.
- Removed the large logo from the shared government-style header and hid the extra accessibility strip/announcement ticker on login pages to keep the header slim and blank in the center.
- Mobile/short viewport footer adjustment to reduce the chance of controls being covered.
- Existing clean URL rewrites in `_redirects` were retained.

## Important scope limitation
The uploaded `frontend.zip` contains static HTML/CSS/JS assets only. It does **not** contain `server.js`, a package manifest, database migrations, or Supabase schema. Therefore this package cannot safely implement or verify backend-dependent requirements such as global Supabase user visibility, server-side Aadhaar duplicate checks, secure CRUD, company/agent branding persistence, fees, payment verification, tracking IDs, staff mapping, or default account activation. Those require the actual deployed backend and its database schema.

## Backend work still required
1. Supply the current `server.js` (and package.json/lockfile) plus Supabase table/schema definitions.
2. Add authenticated, role-checked endpoints for branding read/write, master user listing/search, duplicate-identity lookup, CRUD, fee configuration, payment verification, tracking/status lookup, and agent-staff mapping.
3. Keep Aadhaar/identity values out of public responses and logs; expose only to authorized super-admin endpoints and mask by default in UI.
4. Store branding and registration state in Supabase; do not rely on localStorage for cross-device/company sync.
5. Add Express clean-route mappings for `/agent-login`, `/admin-login`, `/hrms-login`, `/student-login`, `/pfms-login`, `/invoice-login`, and `/admin-dashboard`, with a deliberate 404 fallback and health check.
6. Keep exactly one master-admin identity in server-side configuration/database with hashed credentials, rate limiting, and MFA where possible. Do not grant super-admin rights based only on a frontend role selector.
7. Verify payment callbacks server-to-server before issuing tracking IDs or credentials; never return passwords in a tracking-status endpoint.

## Deployment notes
The `_redirects` file is a Netlify static-hosting rewrite file; it does not configure an Express server by itself. The frontend currently points to the API base configured in `config.js`. Test the updated header on each route and verify the API host and CORS settings before deployment.
