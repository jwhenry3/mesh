import { defineSharedMemory, field } from '@jwhenry123/mesh/sdk';

/**
 * The doorbell layout. One counter the worker bumps after every commit —
 * the main thread observe()s it (Atomics.waitAsync underneath) and flushes
 * the op queue on each tick. Ops themselves still ride postMessage; shared
 * memory only replaces the flush() poll with a push.
 */
const doorbellSpec = {
  opsVersion: field.number(),
};

/** The spec `renderMemory`/`makeDoorbell` share — pinned to the doorbell layout. */
export type DoorbellSpec = typeof doorbellSpec;

/**
 * The worker-side contract. A worker script has ONE module-level instance —
 * the pool's INIT_MEMORY handshake binds it to that worker's own buffer, so
 * every island's worker gets an independent doorbell for free.
 */
export const renderMemory = defineSharedMemory(doorbellSpec);

/**
 * The main-thread side needs one contract INSTANCE per island: a contract
 * object can only be bound to one buffer at a time (bind() rewires its
 * connectors), and each island client creates its own pool with its own
 * SharedArrayBuffer. Same spec, separate instance → separate buffer → a
 * doorbell that only rings for that island's worker.
 */
export const makeDoorbell = () => defineSharedMemory(doorbellSpec);
