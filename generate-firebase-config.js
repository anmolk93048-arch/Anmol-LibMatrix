#!/usr/bin/env node
/* Writes firebase-config.js from environment variables so no key is ever committed.
   Usage (Vercel → Project Settings → Build Command):  node scripts/generate-firebase-config.js
   Required env: FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_DATABASE_URL, FIREBASE_PROJECT_ID, FIREBASE_APP_ID
   Optional env: FIREBASE_STORAGE_BUCKET, FIREBASE_MESSAGING_SENDER_ID, FIREBASE_MEASUREMENT_ID */
const fs = require('fs'), path = require('path');
const map = { apiKey: 'FIREBASE_API_KEY', authDomain: 'FIREBASE_AUTH_DOMAIN', databaseURL: 'FIREBASE_DATABASE_URL', projectId: 'FIREBASE_PROJECT_ID',
  storageBucket: 'FIREBASE_STORAGE_BUCKET', messagingSenderId: 'FIREBASE_MESSAGING_SENDER_ID', appId: 'FIREBASE_APP_ID', measurementId: 'FIREBASE_MEASUREMENT_ID' };
const required = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];
const cfg = {}, missing = [];
Object.keys(map).forEach(k => { const v = (process.env[map[k]] || '').trim(); if (v) cfg[k] = v; else if (required.indexOf(k) >= 0) missing.push(map[k]); });
if (missing.length) { console.error('Missing environment variables: ' + missing.join(', ')); process.exit(1); }
const out = path.join(__dirname, '..', 'firebase-config.js');
fs.writeFileSync(out, '/* GENERATED at build time from environment variables — do not edit or commit. */\nwindow.FIREBASE_CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n');
console.log('firebase-config.js written (' + Object.keys(cfg).length + ' values).');
