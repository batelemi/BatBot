const CACHE = "batbot-v6";
const ASSETS = [
  "/offline.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(async cache => {
      const offlineResponse = await fetch("/offline.html", { cache: "no-cache" });
      if (!offlineResponse.ok) {
        throw new Error("BATBOT : impossible de charger la page hors connexion.");
      }
      await cache.put("/offline.html", offlineResponse);

      await Promise.all(
        ASSETS.filter(url => url !== "/offline.html").map(async url => {
          try {
            const response = await fetch(url, { cache: "no-cache" });
            if (response.ok) {
              await cache.put(url, response);
            }
          } catch (error) {
            console.warn("BATBOT : ressource non mise en cache", url);
          }
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith("batbot-") && key !== CACHE)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Les API restent toujours prioritaires sur le réseau.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Réseau d'abord : ne pas bloquer les mises à jour du site.
  event.respondWith(
    fetch(request).catch(async () => {
      if (request.mode === "navigate") {
        const offlinePage = await caches.match("/offline.html");
        if (offlinePage) return offlinePage;
      }

      const cached = await caches.match(request);
      if (cached) return cached;

      return Response.error();
    })
  );
});
