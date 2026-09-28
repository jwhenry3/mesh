/**
 * Component-reference app handles — `islandApp(name, app)` stamps an app
 * (React component or `{ imperative }` def) with its registry name so the
 * shell can mount by reference: `<Island app={ChartsApp} props={…}/>` gets
 * prop inference from the component's own signature while the wire still
 * carries a string realm key.
 *
 * Why a stamp instead of `Component.name`: bundlers mangle function names
 * in production builds, so `ChartsApp` → 'charts' can't be derived reliably.
 * The stamp is a plain data property — stable through minification.
 */

/** The data property `islandApp` stamps — read by islandAppNameOf. */
const ISLAND_APP_NAME = 'islandAppName';

/**
 * Stamp an app with its registry name. The stamped value IS the app — use
 * it directly as the `apps` map value in `defineIslandWorker` and as the
 * `app` prop of `<Island/>`.
 *
 * ```ts
 * // worker/apps.tsx
 * export const ChartsApp = islandApp('charts', function ChartsApp(props: ChartsProps) { ... });
 * export const mapApp = islandApp('map', { imperative: buildMap });
 * // worker entry: apps: { charts: ChartsApp, map: mapApp }
 * // shell:        <Island app={ChartsApp} props={{ width: 520 }} />
 * ```
 */
export const islandApp = <A>(name: string, app: A): A & { readonly islandAppName: string } => {
  (app as Record<string, unknown>)[ISLAND_APP_NAME] = name;
  return app as A & { readonly islandAppName: string };
};

/**
 * Resolve a mountable app reference to its wire name:
 * string → itself; stamped app → its `islandAppName`; otherwise falls back
 * to displayName/function name (dev-mode convenience — minification may
 * strip it, which is what the stamp exists for). `undefined` when nothing
 * derivable remains.
 */
export const islandAppNameOf = (app: unknown): string | undefined => {
  if (typeof app === 'string') return app === '' ? undefined : app;
  if (app === null || (typeof app !== 'function' && typeof app !== 'object')) return undefined;
  const stamped = (app as unknown as Record<string, unknown>)[ISLAND_APP_NAME];
  if (typeof stamped === 'string' && stamped !== '') return stamped;
  if (typeof app === 'function') {
    const named = app as { displayName?: string; name?: string };
    return named.displayName ?? (named.name !== '' ? named.name : undefined);
  }
  const imp = (app as { imperative?: unknown }).imperative;
  if (typeof imp === 'function') {
    const stampedImp = (imp as unknown as Record<string, unknown>)[ISLAND_APP_NAME];
    if (typeof stampedImp === 'string' && stampedImp !== '') return stampedImp;
    return imp.name !== '' ? imp.name : undefined;
  }
  return undefined;
};

/**
 * The props an app reference infers: a React component's own props, an
 * imperative def's props parameter, `Record<string, unknown>` for plain
 * string names (the un-typed mount path). Interfaces without index
 * signatures still infer here — serialization happens at mount.
 */
export type IslandAppProps<A> = A extends {
  imperative: (doc: never, props: infer P) => void;
}
  ? P
  : A extends (props: infer P) => unknown
    ? P
    : Record<string, unknown>;

/**
 * The structural shape of a mountable app — `never` params so ANY component
 * or imperative def is assignable. Kept worker-free: importing the real
 * `IslandApp` union from `worker/defineIslandWorker` would drag worker code
 * into shell bundles.
 */
export type IslandAppLike =
  | ((props: never) => unknown)
  | { imperative: (doc: never, props: never) => void };
