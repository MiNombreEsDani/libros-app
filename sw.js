// Service worker mínimo: permite instalar la app. No guarda nada en caché
// (los pedidos y la biblioteca siempre se leen en directo).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
