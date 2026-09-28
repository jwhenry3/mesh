/**
 * react-reconciler ships no TypeScript types. It is a CommonJS factory —
 * `Reconciler(hostConfig)` returns the reconciler API (createContainer,
 * updateContainer, flushSyncWork, flushSyncFromReconciler, flushPassiveEffects…).
 * The host config surface is documented in hostConfig.ts.
 */
declare module 'react-reconciler' {
  const createReconciler: (hostConfig: unknown) => {
    createContainer: (...args: unknown[]) => unknown;
    updateContainer: (...args: unknown[]) => unknown;
    updateContainerSync: (...args: unknown[]) => unknown;
    flushSyncWork: () => unknown;
    flushSyncFromReconciler: <T>(fn: () => T) => T;
    flushPassiveEffects: () => boolean;
    [key: string]: unknown;
  };
  export default createReconciler;
}
