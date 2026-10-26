/* SQ-Rijo · service worker: guarda o app no celular para abrir sem internet.
 * Ao publicar uma versão nova, troque o número em CACHE. */
const CACHE = 'sq-rijo-v0.1.0';
const ARQUIVOS = ['./', 'index.html', 'app.js', 'config.js', 'marca.js', 'manifest.json', 'icone-192.png', 'icone-512.png', 'demo-dados.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                        // chamadas ao servidor (POST) nunca passam pelo cache
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // App: usa o que está no celular e atualiza por trás quando houver sinal.
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((cache) => {
      const rede = fetch(req).then((r) => { if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); } return r; }).catch(() => cache);
      return cache || rede;
    }));
  } else if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    // Fontes: guarda depois do primeiro uso; sem sinal, cai na fonte do sistema.
    e.respondWith(caches.match(req).then((c) => c || fetch(req).then((r) => { const copia = r.clone(); caches.open(CACHE).then((k) => k.put(req, copia)); return r; })));
  }
});
