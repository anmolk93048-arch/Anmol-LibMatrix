# Anmol LibMatrix security UX patch

## Included
- `portal-security.js` loaded by the eight static HTML entry pages.
- Context-menu and common developer-shortcut deterrents with a visible message.
- Copy/cut/paste blocking on input, textarea and select elements.
- 15-minute idle timeout, 60-second warning, Stay signed in action, and best-effort logout through `AnmolPortal.logout()` where available.

## Important security limitations
These client-side controls are deterrents only. They cannot reliably disable DevTools, View Source, screenshots, browser extensions, or copying through alternate tools. Never treat them as protection for confidential records. Enforce authorization and session expiry in the Express backend; revoke/expire server sessions or JWTs, validate every API request, set secure HttpOnly cookies where appropriate, use HTTPS, CSP, rate limits and audit logs. The frontend cannot securely expire a token by itself.

The idle timer uses 15 minutes (`IDLE_MS` in `portal-security.js`) and only starts when a recognized token/session key exists. Copy/paste blocking may interfere with password managers and assistive technology; remove those three listeners if accessibility or password-manager support is more important than this deterrent.

## Deployment
Deploy the folder as static frontend assets. This package does not contain `server.js` or the Supabase schema, so it does not implement backend clean routing, server-side token revocation, role authorization, global Aadhaar search, approval workflows, or database-backed branding.
