/**
 * The worker-side surface of @jwhenry123/mesh-worker-dom — import from
 * '@jwhenry123/mesh-worker-dom/worker' inside the worker entry:
 *
 *   import { defineIslandWorker } from '@jwhenry123/mesh-worker-dom/worker';
 *   export const renderWorker = defineIslandWorker({ apps: { ... } });
 *
 * Apps (React or `{ imperative }`) also use from here: `emit` (island→shell
 * channel), `runInRealm` (realm scoping for worker-initiated work), `Slot`
 * (transclusion), `createProxyDocument`/`installDomShim` (imperative DOM).
 */
export { defineIslandWorker, defineRealmWorker } from './defineIslandWorker';
export type {
  DefineIslandWorkerOptions,
  ImperativeIslandApp,
  IslandApp,
  ReactIslandApp,
  Realm,
} from './defineIslandWorker';

export { islandApp, islandAppNameOf } from '../app';

export { hostConfig } from './hostConfig';

export {
  allocId,
  bumpOpsVersion,
  emit,
  getActiveRealm,
  getHandler,
  getRealmSize,
  instances,
  pushOp,
  registerHandler,
  ROOT_CONTAINER,
  runInRealm,
  setActiveRealm,
  setDoorbellContract,
  setRealmSize,
  takeOps,
  unregisterHandler,
} from './realm';
export type { ElementInstance, HostInstance, TextInstance } from './realm';

export {
  createProxyDocument,
  installDomShim,
  installRealmDispatcher,
  ProxyElement,
  ProxyFragment,
  ProxyNode,
  ProxyText,
  realmDocFor,
} from './proxyDom';
export type {
  AdjacentPosition,
  InternalDocument,
  ProxyClassList,
  ProxyDocument,
  ProxyEventHandler,
  WindowShim,
} from './proxyDom';

export { Slot } from './slot';

export type { EventPayload, IslandWorkerMethods, Op, WireProps } from '../ops';
export { isEventRef } from '../ops';
export { renderMemory } from '../memory';
export type { DoorbellSpec } from '../memory';
