/**
 * The main-thread surface of @jwhenry123/mesh-worker-dom — React trees (or
 * imperative proxy-DOM apps) rendered inside Web Workers, replayed onto
 * real DOM here as a serialized op stream. There is no React on this side.
 *
 *   const island = await mountIsland({
 *     client: connectIslandWorker({
 *       worker: () => new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' }),
 *     }),
 *     el: document.getElementById('island')!,
 *     app: 'controls',
 *   });
 */
export { connectIslandWorker, mountIsland } from './island';
export type {
  ConnectIslandWorkerConfig,
  IslandClient,
  IslandHandle,
  IslandWorkerDefinition,
  IslandWorkerOptions,
  Mode,
  MountIslandOptions,
} from './island';

export { makeDoorbell } from './memory';
export type { DoorbellSpec } from './memory';

export { islandApp, islandAppNameOf } from './app';
export type { IslandAppLike, IslandAppProps } from './app';

export { isEventRef } from './ops';
export type {
  EventPayload,
  EventRef,
  IslandWorkerMethods,
  Op,
  WireProps,
} from './ops';
