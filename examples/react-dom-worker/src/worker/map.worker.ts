/**
 * Realm worker — the 1:1 topology: this script serves exactly one app (the
 * Leaflet map island). Its bundle carries the proxy-DOM runtime + the app's
 * lazy Leaflet import — and none of the React apps or recharts. The shell
 * mounts it by the stamped name 'map' (or namelessly — a single-app worker
 * resolves its sole app regardless of the requested name).
 */
import { defineRealmWorker } from '@jwhenry123/mesh-worker-dom/worker';
import { mapApp } from './map';

export const mapWorker = defineRealmWorker(mapApp);
