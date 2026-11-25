/* anmollibmatrix.in - Offline support (Service Worker)
   इसे वेबसाइट की रूट डायरेक्टरी में रखें: /sw.js  (और 404.html भी रूट में) */
const CACHE = "anmol-offline-v4";
const OFFLINE_URL = "/404.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(new Request(OFFLINE_URL, { cache: "reload" }))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(OFFLINE_URL))
  );
});
