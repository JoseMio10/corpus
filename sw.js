// Service worker de Corpus: uso sin conexión. Lo registra src/main.tsx (build normal, https o localhost; nunca en la
// build de artefacto). Rutas relativas al scope del registro (la app usa base './').
//
//   assets/*              cache-first             nombre con hash de Vite: inmutable
//   models/*.glb?v=<hash> cache-first             hash del GLB en catalog.json (tools/comprimir_glb.mjs): inmutable;
//                                                 al guardar una versión se borran las otras del mismo archivo
//   data/*.json           stale-while-revalidate  responde con lo guardado y lo actualiza por detrás
//   navegación            network-first           index.html nuevo en cada despliegue; sin red (o si tarda), el guardado
//   manifest e icono      network-first
//
// Subir VERSION invalida todo: al activarse se borran los cachés corpus-* que no sean de esta versión.
const VERSION = 'v1';
const CACHE_FIJO = `corpus-${VERSION}-fijo`;
const CACHE_DATOS = `corpus-${VERSION}-datos`;
const CACHE_PAGINAS = `corpus-${VERSION}-paginas`;
const VIGENTES = [CACHE_FIJO, CACHE_DATOS, CACHE_PAGINAS];
const BASE = new URL(self.registration.scope);
const INDICE = new URL('./', BASE).href;
const SUELTOS = ['manifest.webmanifest', 'icono.svg'];
const ESPERA_RED_MS = 4000;
const MAX_ASSETS = 80; // tope de assets/* guardados (cada despliegue trae nombres nuevos)

// Qué regla aplica a una URL: 'fijo' | 'datos' | 'suelto' | null (no se toca).
function regla(url) {
  if (url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return null;
  const rel = url.pathname.slice(BASE.pathname.length);
  if (rel.startsWith('assets/')) return 'fijo';
  if (rel.startsWith('models/') && url.searchParams.has('v')) return 'fijo';
  if (rel.startsWith('data/') && rel.endsWith('.json')) return 'datos';
  if (SUELTOS.includes(rel)) return 'suelto';
  return null;
}

const guardable = (r) => r && r.ok && r.status === 200 && r.type === 'basic';
const sinError = (p) => p.then(() => undefined, () => undefined);

// Una respuesta guardada que vino de una redirección no puede responder una navegación: se copia limpia.
async function limpia(r) {
  if (!r || !r.redirected) return r;
  return new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: r.headers });
}

// Tras guardar en CACHE_FIJO: borra otras versiones (?v=) del mismo modelo y recorta los assets más viejos.
async function podar(cache, url) {
  const claves = await cache.keys();
  const rel = url.pathname.slice(BASE.pathname.length);
  if (rel.startsWith('models/')) {
    for (const k of claves) {
      const u = new URL(k.url);
      if (u.pathname === url.pathname && u.search !== url.search) await cache.delete(k);
    }
  } else {
    const assets = claves.filter((k) => new URL(k.url).pathname.startsWith(BASE.pathname + 'assets/'));
    for (const k of assets.slice(0, Math.max(0, assets.length - MAX_ASSETS))) await cache.delete(k);
  }
}

async function cachePrimero(ev) {
  const req = ev.request;
  const cache = await caches.open(CACHE_FIJO);
  const guardada = await cache.match(req);
  if (guardada) return guardada;
  const r = await fetch(req);
  if (guardable(r)) {
    // Sin await: la página recibe el cuerpo mientras baja (barra de progreso de los GLB).
    const copia = r.clone();
    ev.waitUntil(sinError(cache.put(req, copia).then(() => podar(cache, new URL(req.url)))));
  }
  return r;
}

function guardadoYRevalidar(ev) {
  const req = ev.request;
  const red = fetch(req).then((r) => {
    if (guardable(r)) {
      const copia = r.clone();
      ev.waitUntil(sinError(caches.open(CACHE_DATOS).then((c) => c.put(req, copia))));
    }
    return r;
  });
  ev.waitUntil(sinError(red));
  return caches
    .open(CACHE_DATOS)
    .then((c) => c.match(req))
    .then((g) => g || red);
}

// Network-first con plazo: si hay copia guardada y la red falla, responde error o tarda más de ESPERA_RED_MS, va la copia.
async function redPrimero(ev, clave, soloHtml) {
  const req = ev.request;
  const cache = await caches.open(CACHE_PAGINAS);
  const red = fetch(req).then((r) => {
    const esHtml = (r.headers.get('content-type') || '').includes('text/html');
    if (guardable(r) && (!soloHtml || esHtml)) {
      const copia = r.clone();
      ev.waitUntil(sinError(cache.put(clave, copia)));
    }
    return r;
  });
  ev.waitUntil(sinError(red));
  const guardada = await limpia(await cache.match(clave));
  if (!guardada) return red;
  return new Promise((resolve) => {
    const plazo = setTimeout(() => resolve(guardada), ESPERA_RED_MS);
    red.then(
      (r) => { clearTimeout(plazo); resolve(r.ok || r.type === 'opaqueredirect' ? r : guardada); },
      () => { clearTimeout(plazo); resolve(guardada); },
    );
  });
}

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_PAGINAS);
        await cache.addAll([INDICE, ...SUELTOS.map((s) => new URL(s, BASE).href)]);
      } catch {
        // Sin red al instalar: se llena con el uso.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('corpus-') && !VIGENTES.includes(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    if (url.origin === BASE.origin && url.pathname.startsWith(BASE.pathname)) ev.respondWith(redPrimero(ev, INDICE, true));
    return;
  }
  const r = regla(url);
  if (r === 'fijo') ev.respondWith(cachePrimero(ev));
  else if (r === 'datos') ev.respondWith(guardadoYRevalidar(ev));
  else if (r === 'suelto') ev.respondWith(redPrimero(ev, url.href, false));
});

// En la primera visita la página pide casi todo antes de que este SW la controle: src/main.tsx manda las URL ya
// cargadas (Resource Timing) y aquí se guardan las que siguen las reglas de arriba. Salen de la caché HTTP del
// navegador (los GLB y assets son inmutables), no se vuelven a bajar.
self.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || d.tipo !== 'precargar' || !Array.isArray(d.urls)) return;
  ev.waitUntil(sinError(precargar(d.urls.slice(0, 300))));
});

async function precargar(urls) {
  for (const u of urls) {
    let url;
    try {
      url = new URL(String(u), BASE);
    } catch {
      continue;
    }
    const r = regla(url);
    if (r !== 'fijo' && r !== 'datos') continue;
    const cache = await caches.open(r === 'fijo' ? CACHE_FIJO : CACHE_DATOS);
    if (await cache.match(url.href)) continue;
    try {
      const resp = await fetch(url.href);
      if (guardable(resp)) {
        await cache.put(url.href, resp);
        if (r === 'fijo') await podar(cache, url);
      }
    } catch {
      // Sin red: queda para la próxima visita.
    }
  }
}
