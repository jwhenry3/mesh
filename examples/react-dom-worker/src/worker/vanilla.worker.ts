/**
 * Realm worker — the 1:1 topology: this script serves exactly one app (the
 * imperative proxy-DOM island). Its bundle is just the proxy-DOM runtime +
 * the vendored widget — none of the React apps or recharts (the shared
 * worker chunk still carries the reconciler, which the imperative path
 * never instantiates).
 */
import { defineRealmWorker } from '@jwhenry123/mesh-worker-dom/worker';
import { vanillaApp } from './vanilla';

export const vanillaWorker = defineRealmWorker(vanillaApp);
