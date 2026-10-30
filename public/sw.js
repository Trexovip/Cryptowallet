// Minimal service worker: network-first for the app shell (fresh when online, works offline),
// never caches API/auth responses.
const C = "kryvonwallet-v1";
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => { self.clients.claim(); e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k))))); });
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  const shell = u.pathname === "/" || u.pathname === "/setup" || u.pathname.startsWith("/static/") || u.pathname === "/manifest.webmanifest";
  if (!shell) return; // let API and everything else hit the network directly
  e.respondWith(
    fetch(e.request).then((r) => { const cp = r.clone(); caches.open(C).then((c) => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request))
  );
});
