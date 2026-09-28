/**
 * The 'map' island app — a REAL interactive map (Leaflet 1.9, unmodified
 * from npm) running entirely inside the worker on the proxy DOM. The
 * hardest realistic DOM-dependent library we could point at the shim:
 * Leaflet measures its container, stashes expandos on elements, creates
 * absolutely-positioned tile <img>s, attaches its own event layer with
 * delegated document listeners, and drives drag/wheel zoom through
 * requestAnimationFrame + timers.
 *
 * Why `await import('leaflet')`: the library evaluates `document` and
 * `window` globals at module scope (Browser feature detection), so the
 * shim MUST be installed before it loads — a static import would run it
 * against a bare worker globalThis and crash the whole worker entry at
 * boot. The dynamic import also keeps the library out of the worker
 * chunk's eager path.
 *
 * What the proxy DOM supplies it: real container geometry via the pushed
 * setSize channel (doc.body is the island container), expando-friendly
 * unfrozen elements (_leaflet_pos/_leaflet_events), reflected property
 * setters (`tile.src`, `link.href`, `container.tabIndex`), style/attr/class
 * ops, `document`/`window` delegated listeners on the island root, payload
 * enrichment (clientX/Y, deltaY, which, modifiers), and no-op
 * preventDefault/stopPropagation on dispatched payloads.
 */
import {
  bumpOpsVersion,
  emit,
  getActiveRealm,
  installDomShim,
  islandApp,
  runInRealm,
  type ProxyDocument,
} from '@jwhenry123/mesh-worker-dom/worker';

export interface MapMarker {
  id: string;
  label: string;
  lat: number;
  lng: number;
}

export interface MapPlace {
  name: string;
  lat: number;
  lng: number;
  zoom: number;
}

/** Demo data — a few European cities with clickable pins. */
const MARKERS: MapMarker[] = [
  { id: 'paris', label: 'Paris', lat: 48.8566, lng: 2.3522 },
  { id: 'berlin', label: 'Berlin', lat: 52.52, lng: 13.405 },
  { id: 'london', label: 'London', lat: 51.5074, lng: -0.1278 },
];

const PLACES: MapPlace[] = [
  { name: 'Lisbon', lat: 38.7223, lng: -9.1393, zoom: 12 },
  { name: 'Oslo', lat: 59.9139, lng: 10.7522, zoom: 12 },
  { name: 'Rome', lat: 41.9028, lng: 12.4964, zoom: 12 },
];

type LeafletModule = typeof import('leaflet');

// One map instance per realm document — keyed by doc so multiple map realms
// in the same in-process module graph don't collide.
const liveMaps = new WeakMap<ProxyDocument, { remove(): void }>();

export function buildMap(doc: ProxyDocument, props: Record<string, unknown>): void {
  const realm = getActiveRealm();

  // Leaflet binds to globalThis.document/window — install BEFORE the
  // dynamic import so its module-scope Browser detection sees the proxy.
  installDomShim(doc);

  // The island root IS the Leaflet container: doc.body already reports the
  // pushed size, and its attr/style ops target the real element. Give it a
  // concrete CSS box so the shell sees a real map-sized element.
  const host = doc.body;
  host.style.position = 'relative';
  host.style.height = '420px';
  host.style.padding = '0';

  void import('leaflet')
    .then((L) => {
      // Runs outside a task — hold the realm so emit()/instance-less ops
      // route, then ring the doorbell so the queue drains immediately.
      runInRealm(realm, () => startLeaflet(L, doc, props, realm));
      bumpOpsVersion();
    })
    .catch((err: unknown) => {
      console.error('[map island] leaflet failed to start on the proxy DOM:', err);
    });
}

function startLeaflet(
  L: LeafletModule,
  doc: ProxyDocument,
  props: Record<string, unknown>,
  realm: string,
): void {
  const host = doc.body as unknown as HTMLElement;

  const map = L.map(host, {
    zoomControl: true,
    attributionControl: true,
    // The shim reports no pointer/touch support (honest) — Leaflet falls
    // back to mouse events, which the driver carries faithfully.
  });

  const startLat = typeof props.lat === 'number' ? props.lat : 48.8566;
  const startLng = typeof props.lng === 'number' ? props.lng : 2.3522;
  const startZoom = typeof props.zoom === 'number' ? props.zoom : 5;
  map.setView([startLat, startLng], startZoom);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // divIcon markers — no image assets needed, just DOM the proxy can ship.
  for (const m of MARKERS) {
    const marker = L.marker([m.lat, m.lng], {
      title: m.label,
      icon: L.divIcon({
        className: 'mesh-map-pin',
        html: `<span class="mesh-map-pin-dot"></span><span class="mesh-map-pin-label">${m.label}</span>`,
        iconSize: [80, 28],
        iconAnchor: [8, 14],
      }),
    });
    marker.on('click', () => {
      emit('markerClicked', { id: m.id, label: m.label, lat: m.lat, lng: m.lng });
    });
    marker.addTo(map);
  }

  // A "go to city" control, built through Leaflet's own control API.
  const places = L.Control.extend({
    onAdd: () => {
      const box = document.createElement('div');
      box.className = 'leaflet-bar mesh-map-places';
      for (const place of PLACES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mesh-map-place-btn';
        btn.textContent = place.name;
        btn.addEventListener('click', () => {
          map.setView([place.lat, place.lng], place.zoom);
          emit('placeSelected', { name: place.name, lat: place.lat, lng: place.lng });
        });
        box.appendChild(btn);
      }
      return box as unknown as HTMLElement;
    },
  });
  new places({ position: 'bottomleft' }).addTo(map);

  // The pushed-size channel: every ResizeObserver tick on the island's el
  // lands here — tell Leaflet to re-measure its container.
  doc.onResize(() => {
    map.invalidateSize();
  });

  // Leaflet fires `zoomend` from ScrollWheelZoom's debounce timer — OUTSIDE
  // any realm task — so a bare emit() has no active realm to route to and
  // the op would be dropped. Re-enter the realm and ring the doorbell so
  // the queued op wakes the driver immediately.
  map.on('zoomend', () => {
    runInRealm(realm, () => {
      emit('zoomChanged', { zoom: map.getZoom() });
      bumpOpsVersion();
    });
  });

  liveMaps.set(doc, map);
}

/** Stamped registry def — mountable by reference (`lazyIsland(() => import('./map'))`). */
export const mapApp = islandApp('map', {
  imperative: buildMap,
  /** Cancel Leaflet timers/listeners and tile loads before the proxy doc dies. */
  dispose(doc: ProxyDocument) {
    liveMaps.get(doc)?.remove();
    liveMaps.delete(doc);
  },
});
