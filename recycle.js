'use strict';
/* Anmol LibMatrix — Recycle Bin / Restore Center.
 *
 *  A thin layer over db.query: before a statement that would erase data runs, the data is copied into `recycle_bin`
 *  (Supabase/Postgres). Everything that deletes data on ANY portal — a single delete, an agent "Factory Reset",
 *  the Super Admin "Reset Factory All", blob/entity overwrites that drop records — passes through here, so no route
 *  has to be changed one by one.
 *
 *  Captured:
 *   • kv_admin_entities / kv_blob writes (admins, staff, agents, students, agent_logins, hrms_*, att_records, fee_records,
 *     members, material_categories …): records that disappear from the saved list/object   → kind 'kv_item' / 'kv_keys'
 *   • DELETE FROM material_users / material_bills / material_user_requests / pfms_users / payout_requests /
 *     agent_wallets / transactions / attendance_records / fee_payments                       → kind 'row'
 *   • DELETE FROM kv_blob WHERE key = ?                                                    → whole blob
 *  Also watches password updates (to sign out every session of that account — see account-security.js).
 *
 *  Super Admin API:  GET /api/recycle-bin · POST /:id/restore · POST /restore-batch · POST /:id/purge · POST /purge
 *  A purged record has its payload erased and can NEVER be restored.
 */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const ROW_TABLES = ['material_users', 'material_bills', 'material_user_requests', 'pfms_users', 'payout_requests', 'agent_wallets', 'transactions', 'attendance_records', 'fee_payments'];
const NOISE_KEYS = new Set(['activity', 'live_dashboard', 'tracking_records', 'sessions_valid_after', 'comments']);   // trimmed automatically / not user data
const MAX_ITEMS = 5000;
const lc = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };

function create(ctx) {
    const als = new AsyncLocalStorage();
    const raw = ctx.rawQuery;                                   // unwrapped db.query (promise)
    let ready = null;

    function ensureTable() {
        if (!ready) ready = raw('CREATE TABLE IF NOT EXISTS recycle_bin (id SERIAL PRIMARY KEY, batch_id VARCHAR(40), source VARCHAR(160), kind VARCHAR(16), record_key VARCHAR(220), label VARCHAR(320), reason VARCHAR(20), payload TEXT, deleted_by VARCHAR(160), deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, status VARCHAR(12) DEFAULT \'deleted\', restored_at TIMESTAMP, restored_by VARCHAR(160), purged_at TIMESTAMP, purged_by VARCHAR(160))', [])
            .then(function () { return raw('CREATE INDEX IF NOT EXISTS recycle_bin_status_idx ON recycle_bin (status, deleted_at DESC)', []); })
            .catch(function (e) { ready = null; throw e; });
        return ready;
    }
    function actor() {
        try { const s = als.getStore(); const a = s && s.req && ctx.getAuthUser(s.req); return a ? String(a.via || a.username || a.userId || a.role) : 'system'; } catch (e) { return 'system'; }
    }
    const recKey = function (r) {
        if (r && typeof r === 'object') {
            const k = [r.id, r.userId, r.userid, r.username, r.studentId, r.agentId, r.empId, r.empid, r.billId, r.invoiceNo, r.mobile, r.phone, r.key].find(function (x) { return x != null && x !== ''; });
            if (k !== undefined) return String(k).slice(0, 200);
        }
        return null;
    };
    const labelOf = function (r, k) {
        if (!r || typeof r !== 'object') return String(r).slice(0, 120);
        const n = r.name || r.fullName || r.studentName || r.customerName || r.title || r.username || r.userid || r.label || '';
        const i = r.id || r.userId || r.studentId || r.agentId || r.empId || r.invoiceNo || '';
        return (String(n) + (i && String(i) !== String(n) ? ' (' + i + ')' : '')).trim().slice(0, 300) || String(k || '');
    };

    async function insertRows(rows) {
        if (!rows.length) return;
        await ensureTable();
        const by = actor();
        for (let i = 0; i < rows.length; i += 200) {
            const chunk = rows.slice(i, i + 200), ph = [], vals = [];
            chunk.forEach(function (r) {
                ph.push('(?,?,?,?,?,?,?,?)');
                vals.push(r.batch, r.source, r.kind, r.key, r.label, r.reason, r.payload, by);
            });
            await raw('INSERT INTO recycle_bin (batch_id, source, kind, record_key, label, reason, payload, deleted_by) VALUES ' + ph.join(','), vals);
        }
    }

    // ── kv_admin_entities / kv_blob: what vanished between the stored value and the one being written? ──
    async function kvDiff(table, key, newJson) {
        if (NOISE_KEYS.has(key)) return;
        const r = await raw('SELECT value FROM ' + table + ' WHERE "key" = ?', [key]);
        if (!r.length) return;
        let prev, next;
        try { prev = JSON.parse(r[0].value); } catch (e) { return; }
        try { next = newJson === null ? null : JSON.parse(newJson); } catch (e) { return; }
        const source = table + ':' + key, batch = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
        const out = [];
        const isObj = function (x) { return x && typeof x === 'object' && !Array.isArray(x); };
        if (Array.isArray(prev) && prev.length) {
            const nextArr = Array.isArray(next) ? next : [];
            const seen = new Set(); nextArr.forEach(function (x) { const k = recKey(x); if (k != null) seen.add(k); });
            const wipe = nextArr.length === 0;
            prev.forEach(function (x) {
                if (out.length >= MAX_ITEMS || x == null) return;
                const k = recKey(x);
                if (k == null) { if (wipe) out.push({ batch: batch, source: source, kind: 'kv_item', key: 'h:' + crypto.createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 16), label: labelOf(x), reason: 'wipe', payload: JSON.stringify(x) }); return; }
                if (!seen.has(k)) out.push({ batch: batch, source: source, kind: 'kv_item', key: k, label: labelOf(x, k), reason: null, payload: JSON.stringify(x) });
            });
            const reason = wipe ? 'wipe' : 'delete';
            out.forEach(function (o) { o.reason = reason; });
            // password edits inside the list → sign that account out everywhere
            if (table === 'kv_admin_entities' && Array.isArray(next)) {
                const old = new Map(); prev.forEach(function (x) { const k = recKey(x); if (k != null && x) old.set(k, x); });
                const ids = [];
                next.forEach(function (x) { const k = recKey(x), o = k != null && old.get(k); if (o && x && x.password && o.password && x.password !== o.password) ids.push(x.username, x.email, x.id, x.agentId, x.empId); });
                if (ids.length && ctx.bump) ctx.bump(ids);
            }
        } else if (isObj(prev) && Object.keys(prev).length) {
            const nextObj = isObj(next) ? next : {};
            const gone = Object.keys(prev).filter(function (k) { return !(k in nextObj); });
            if (gone.length) {
                const kept = {}; gone.slice(0, MAX_ITEMS).forEach(function (k) { kept[k] = prev[k]; });
                out.push({ batch: batch, source: source, kind: 'kv_keys', key: gone.length + ' entries', label: source + ' — ' + gone.length + ' entr' + (gone.length === 1 ? 'y' : 'ies') + ' (' + gone.slice(0, 3).join(', ') + (gone.length > 3 ? '…' : '') + ')', reason: Object.keys(nextObj).length === 0 ? 'wipe' : 'delete', payload: JSON.stringify({ keys: kept }) });
            }
        }
        await insertRows(out);
    }

    // ── DELETE FROM <row table> ──
    async function rowDelete(table, where, params) {
        const rows = await raw('SELECT * FROM ' + table + (where ? ' WHERE ' + where : '') + ' LIMIT ' + MAX_ITEMS, params);
        const batch = Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), reason = !where ? 'wipe' : 'delete';
        await insertRows(rows.map(function (row) {
            const k = row.id != null ? row.id : (row.userid || row.username || row.key || '');
            return { batch: batch, source: table, kind: 'row', key: String(k), label: labelOf(row, k), reason: reason, payload: JSON.stringify(row) };
        }));
    }

    async function before(sql, params) {
        params = params || [];
        let m = /^\s*INSERT\s+INTO\s+(kv_admin_entities|kv_blob)\s*\(\s*[`"]key[`"]\s*,\s*value\s*\)\s*VALUES\s*\(\s*\?\s*,\s*\?\s*\)\s*ON\s+CONFLICT/i.exec(sql);
        if (m && params.length >= 2) return kvDiff(m[1].toLowerCase(), String(params[0]), params[1]);
        m = /^\s*DELETE\s+FROM\s+kv_blob\s+WHERE\s+[`"]?key[`"]?\s*=\s*\?/i.exec(sql);
        if (m) return kvDiff('kv_blob', String(params[0]), null);
        m = /^\s*DELETE\s+FROM\s+([a-z_]+)\s*(?:WHERE\s+([\s\S]*?))?\s*(?:RETURNING\s+[\s\S]*)?;?\s*$/i.exec(sql);
        if (m && ROW_TABLES.indexOf(m[1].toLowerCase()) >= 0) return rowDelete(m[1].toLowerCase(), m[2] || '', m[2] ? params : []);
        m = /^\s*UPDATE\s+(material_users|pfms_users)\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*?)\s*;?\s*$/i.exec(sql);
        if (m && /\bpassword(_hash)?\s*=/i.test(m[2]) && ctx.bump) {
            const off = (m[2].match(/\?/g) || []).length;
            const rows = await raw('SELECT * FROM ' + m[1].toLowerCase() + ' WHERE ' + m[3], params.slice(off));
            ctx.bump([].concat.apply([], rows.map(function (r) { return [r.userid, r.username, r.id]; })));
        }
    }

    function install(db, origQuery) {
        db.query = function (sql, params, cb) {
            if (typeof params === 'function') { cb = params; params = undefined; }
            if (typeof sql !== 'string' || !/^\s*(INSERT|DELETE|UPDATE)\b/i.test(sql)) return origQuery(sql, params, cb);
            Promise.resolve().then(function () { return before(sql, params); })
                .catch(function (e) { console.warn('recycle bin capture skipped:', e && e.message); })
                .then(function () { origQuery(sql, params, cb); });
        };
    }

    // ── restore ──
    async function restoreOne(row, by) {
        if (row.status !== 'deleted') throw Object.assign(new Error('This record is already ' + row.status + '.'), { status: 409 });
        if (!row.payload) throw Object.assign(new Error('This record was permanently purged and cannot be restored.'), { status: 410 });
        const data = JSON.parse(row.payload);
        if (row.kind === 'row') {
            const cols = Object.keys(data).filter(function (c) { return /^[a-z_][a-z0-9_]*$/i.test(c); });
            const r = await raw('INSERT INTO ' + row.source + ' (' + cols.map(function (c) { return '"' + c + '"'; }).join(',') + ') VALUES (' + cols.map(function () { return '?'; }).join(',') + ') ON CONFLICT DO NOTHING RETURNING 1 AS ok', cols.map(function (c) { const v = data[c]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v; }));
            if (!r.length) throw Object.assign(new Error('A record with the same ID already exists, so nothing was overwritten.'), { status: 409 });
        } else {
            const i = row.source.indexOf(':'), table = row.source.slice(0, i), key = row.source.slice(i + 1);
            if (table !== 'kv_admin_entities' && table !== 'kv_blob') throw new Error('Unknown source.');
            const cur = await raw('SELECT value FROM ' + table + ' WHERE "key" = ?', [key]);
            let val = null; try { val = cur.length ? JSON.parse(cur[0].value) : null; } catch (e) { val = null; }
            if (row.kind === 'kv_item') {
                if (val == null || (val && typeof val === 'object' && !Array.isArray(val) && !Object.keys(val).length)) val = [];
                if (!Array.isArray(val)) throw Object.assign(new Error('The current data has a different shape — restore blocked to protect it.'), { status: 409 });
                const k = recKey(data), at = k == null ? -1 : val.findIndex(function (x) { return recKey(x) === k; });
                if (at >= 0) val[at] = data; else val.push(data);
            } else {
                if (val == null || Array.isArray(val) && !val.length) val = {};
                if (typeof val !== 'object' || Array.isArray(val)) throw Object.assign(new Error('The current data has a different shape — restore blocked to protect it.'), { status: 409 });
                let added = 0; Object.keys(data.keys || {}).forEach(function (k) { if (!(k in val)) { val[k] = data.keys[k]; added++; } });
                if (!added) throw Object.assign(new Error('All of these entries already exist again.'), { status: 409 });
            }
            await raw('INSERT INTO ' + table + ' ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(val)]);
            if (key === 'agents' && ctx.clearScopeCache) ctx.clearScopeCache();
        }
        await raw('UPDATE recycle_bin SET status = \'restored\', restored_at = CURRENT_TIMESTAMP, restored_by = ? WHERE id = ?', [by, row.id]);
    }

    function mount(app) {
        app.use(function (req, res, next) { als.run({ req: req }, next); });
        const admin = ctx.requireRole('admin');
        const by = function (req) { return String(req.authUser.via || req.authUser.username || 'admin'); };
        const ids = function (b) { return (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(function (n) { return n > 0; }).slice(0, 5000); };

        app.get('/api/recycle-bin', admin, ctx.asyncRoute(async function (req, res) {
            await ensureTable();
            const q = req.query, w = [], p = [];
            const status = ['deleted', 'restored', 'purged'].indexOf(q.status) >= 0 ? q.status : (q.status === 'all' ? null : 'deleted');
            if (status) { w.push('status = ?'); p.push(status); }
            if (q.source) { w.push('source LIKE ?'); p.push(String(q.source).slice(0, 80) + '%'); }
            if (q.batch) { w.push('batch_id = ?'); p.push(String(q.batch).slice(0, 40)); }
            if (q.q) { w.push('(LOWER(label) LIKE ? OR LOWER(record_key) LIKE ?)'); const t = '%' + lc(q.q).slice(0, 60) + '%'; p.push(t, t); }
            const where = w.length ? ' WHERE ' + w.join(' AND ') : '';
            const limit = Math.min(500, parseInt(q.limit, 10) || 200), offset = Math.max(0, parseInt(q.offset, 10) || 0);
            const items = await raw('SELECT id, batch_id, source, kind, record_key, label, reason, deleted_by, deleted_at, status, restored_at, restored_by, purged_at, purged_by FROM recycle_bin' + where + ' ORDER BY id DESC LIMIT ' + limit + ' OFFSET ' + offset, p);
            const total = await raw('SELECT COUNT(*) AS n FROM recycle_bin' + where, p);
            const counts = await raw('SELECT source, COUNT(*) AS n FROM recycle_bin WHERE status = \'deleted\' GROUP BY source ORDER BY n DESC', []);
            res.set('Cache-Control', 'no-store').json({ success: true, items: items, total: Number(total[0] && total[0].n) || 0, counts: counts });
        }));
        app.post('/api/recycle-bin/:id/restore', admin, ctx.asyncRoute(async function (req, res) {
            await ensureTable();
            const r = await raw('SELECT * FROM recycle_bin WHERE id = ?', [Number(req.params.id) || 0]);
            if (!r.length) return res.status(404).json({ error: 'Record not found in the Recycle Bin.' });
            try { await restoreOne(r[0], by(req)); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
            res.json({ success: true, message: 'Restored — it is back on its portal with all its original data.' });
        }));
        app.post('/api/recycle-bin/restore-batch', admin, ctx.asyncRoute(async function (req, res) {
            await ensureTable();
            const b = req.body || {};
            let rows;
            if (b.batch) rows = await raw('SELECT * FROM recycle_bin WHERE batch_id = ? AND status = \'deleted\' ORDER BY id', [String(b.batch).slice(0, 40)]);
            else { const l = ids(b); if (!l.length) return res.status(400).json({ error: 'Select at least one record.' }); rows = await raw('SELECT * FROM recycle_bin WHERE status = \'deleted\' AND id IN (' + l.map(function () { return '?'; }).join(',') + ') ORDER BY id', l); }
            let ok = 0; const failed = [];
            for (let i = 0; i < rows.length; i++) { try { await restoreOne(rows[i], by(req)); ok++; } catch (e) { failed.push({ id: rows[i].id, label: rows[i].label, error: e.message }); } }
            res.json({ success: true, restored: ok, failed: failed });
        }));
        const purgeGuard = async function (req, res) {
            const pw = String((req.body && req.body.password) || '');
            if (!pw) { res.status(400).json({ error: 'Enter your Super Admin password to purge permanently.' }); return false; }
            if (ctx.hitRateLimit('purge:' + by(req), 8, 60 * 1000)) { res.status(429).json({ error: 'Too many attempts. Please wait a minute.' }); return false; }
            if (!(await ctx.verifyAdminPassword(req.authUser, pw))) { res.status(401).json({ error: 'Incorrect Super Admin password.' }); return false; }
            return true;
        };
        const purgeSql = 'UPDATE recycle_bin SET status = \'purged\', payload = NULL, purged_at = CURRENT_TIMESTAMP, purged_by = ? WHERE status = \'deleted\'';
        app.post('/api/recycle-bin/:id/purge', admin, ctx.asyncRoute(async function (req, res) {
            await ensureTable();
            if (!(await purgeGuard(req, res))) return;
            const r = await raw(purgeSql + ' AND id = ? RETURNING id', [by(req), Number(req.params.id) || 0]);
            if (!r.length) return res.status(404).json({ error: 'Record not found, or it is not in the Recycle Bin.' });
            res.json({ success: true, message: 'Permanently purged. This cannot be undone.' });
        }));
        app.post('/api/recycle-bin/purge', admin, ctx.asyncRoute(async function (req, res) {
            await ensureTable();
            if (!(await purgeGuard(req, res))) return;
            const b = req.body || {};
            let r;
            if (b.all === true) r = await raw(purgeSql + ' RETURNING id', [by(req)]);
            else if (b.batch) r = await raw(purgeSql + ' AND batch_id = ? RETURNING id', [by(req), String(b.batch).slice(0, 40)]);
            else { const l = ids(b); if (!l.length) return res.status(400).json({ error: 'Select at least one record.' }); r = await raw(purgeSql + ' AND id IN (' + l.map(function () { return '?'; }).join(',') + ') RETURNING id', [by(req)].concat(l)); }
            res.json({ success: true, purged: r.length });
        }));
        ensureTable().catch(function () {});
    }
    return { install: install, mount: mount, ensureTable: ensureTable };
}
module.exports = { create: create };
