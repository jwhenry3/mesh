// Embedded sources — ?raw inlines the real files at build/serve time, so the
// docs always show the code that actually ships in this repo.
import reactBinding from '../../packages/react/src/index.ts?raw';
import reactGlue from '../../examples/react/src/useIncidents.ts?raw';
import reactView from '../../examples/react/src/App.tsx?raw';
import vueBinding from '../../packages/vue/src/index.ts?raw';
import vueGlue from '../../examples/vue/src/useIncidents.ts?raw';
import vueView from '../../examples/vue/src/App.vue?raw';
import solidBinding from '../../packages/solidjs/src/index.ts?raw';
import solidGlue from '../../examples/solid/src/incidents.ts?raw';
import solidView from '../../examples/solid/src/App.tsx?raw';
import svelteBinding from '../../packages/svelte/src/reactivity.svelte.ts?raw';
import svelteGlue from '../../examples/svelte/src/incidents.svelte.ts?raw';
import svelteView from '../../examples/svelte/src/App.svelte?raw';
import angularBinding from '../../packages/angular/src/index.ts?raw';
import angularGlue from '../../examples/angular/src/app.component.ts?raw';
import angularView from '../../examples/angular/src/app.component.html?raw';
import nextjsBinding from '../../packages/nextjs/src/index.ts?raw';
import nextjsGlue from '../../examples/nextjs/src/useIncidents.ts?raw';
import nextjsView from '../../examples/nextjs/src/IncidentsApp.tsx?raw';

export interface FrameworkDoc {
  id: string;
  name: string;
  port: number;
  binding: string;
  summary: string;
  apis: { name: string; signature: string; desc: string }[];
  /** Optional NgModule-form section (Angular) — mirrors the NestJS page's MeshModule block. */
  moduleSnippet?: { title: string; blurb: string; code: string; file: string };
  bindingSource: string;
  bindingFile: string;
  glueSource: string;
  glueFile: string;
  viewSource: string;
  viewFile: string;
  viewLanguage: string;
  notes: string[];
}

const VALUE_API = (name: string, sig: string, returns: string) => ({
  name,
  signature: sig,
  desc: `Bind one shared-memory field. ${returns}; updates on every write, local or remote.`,
});

export const FRAMEWORKS: FrameworkDoc[] = [
  {
    id: 'react',
    name: 'React',
    port: 5173,
    binding: '@jwhenry123/mesh-react',
    summary:
      'Hook adapter over useSyncExternalStore. SSR-safe — field reads return undefined until the contract binds on the client.',
    apis: [
      { name: 'useObservable', signature: 'useObservable(source: ObservableValue<T>): T', desc: 'Subscribe to any observable snapshot (task or field).' },
      VALUE_API('useSharedValue', 'useSharedValue(memory, key): T | undefined', 'returns the field value as React state'),
      { name: 'useTask', signature: 'useTask(task | asyncFn): { data, pending, settled, elapsedMs, error, run, runOnce }', desc: 'Bind an AsyncTask — or any async fn (e.g. a client method) — to state and get its triggers.' },
    ],
    bindingSource: reactBinding,
    bindingFile: 'packages/react/src/index.ts',
    glueSource: reactGlue,
    glueFile: 'examples/react/src/useIncidents.ts',
    viewSource: reactView,
    viewFile: 'examples/react/src/App.tsx',
    viewLanguage: 'tsx',
    notes: [
      'The page query object is memoized (useMemo) so the effect only re-fires when the spec actually changes.',
      'runOnce() makes the init task StrictMode-safe — double mounts skip a second seed.',
      'Worker-hosted React trees (islands) live in the companion package @jwhenry123/mesh-react-island — see the Worker islands page under this section.',
    ],
  },
  {
    id: 'vue',
    name: 'Vue',
    port: 5174,
    binding: '@jwhenry123/mesh-vue',
    summary:
      'Composable adapter producing Refs. Subscriptions release via onScopeDispose when the component unmounts.',
    apis: [
      { name: 'useObservable', signature: 'useObservable(source: ObservableValue<T>): Ref<T>', desc: 'Subscribe to any observable snapshot (task or field).' },
      VALUE_API('useSharedValue', 'useSharedValue(memory, key): Ref<T | undefined>', 'returns the field value as a Ref'),
      { name: 'useTask', signature: 'useTask(task | asyncFn): { state: Ref<TaskSnapshot>, run, runOnce }', desc: 'Bind an AsyncTask — or any async fn — to a Ref and get its triggers.' },
    ],
    bindingSource: vueBinding,
    bindingFile: 'packages/vue/src/index.ts',
    glueSource: vueGlue,
    glueFile: 'examples/vue/src/useIncidents.ts',
    viewSource: vueView,
    viewFile: 'examples/vue/src/App.vue',
    viewLanguage: 'vue',
    notes: [
      'The query spec is a computed Ref — watch([query, settled]) re-runs the page task on any change.',
    ],
  },
  {
    id: 'solid',
    name: 'SolidJS',
    port: 5175,
    binding: '@jwhenry123/mesh-solidjs',
    summary:
      'Signal adapter. The sdk itself uses solid-js internally for reactive(), so shared values are native tracked signals.',
    apis: [
      { name: 'createObservable', signature: 'createObservable(source: ObservableValue<T>): Accessor<T>', desc: 'Subscribe to any observable snapshot (task or field).' },
      VALUE_API('createSharedValue', 'createSharedValue(memory, key): Accessor<T | undefined>', 'returns the field value as an Accessor'),
      { name: 'createTask', signature: 'createTask(task | asyncFn): { state: Accessor<TaskSnapshot>, run, runOnce }', desc: 'Bind an AsyncTask — or any async fn — to a signal and get its triggers.' },
    ],
    bindingSource: solidBinding,
    bindingFile: 'packages/solidjs/src/index.ts',
    glueSource: solidGlue,
    glueFile: 'examples/solid/src/incidents.ts',
    viewSource: solidView,
    viewFile: 'examples/solid/src/App.tsx',
    viewLanguage: 'tsx',
    notes: [
      'createEffect re-runs the page task whenever the memoized query spec changes.',
      'Subscriptions auto-dispose via onCleanup when the component is destroyed.',
    ],
  },
  {
    id: 'svelte',
    name: 'Svelte',
    port: 5176,
    binding: '@jwhenry123/mesh-svelte',
    summary:
      'Svelte 5 runes adapter. Functions must be called during component init; teardown happens in an $effect cleanup.',
    apis: [
      { name: 'observableValue', signature: 'observableValue(source): { value: T }', desc: 'Subscribe to any observable snapshot as rune-backed state.' },
      VALUE_API('sharedValue', 'sharedValue(memory, key): { value: T | undefined }', 'returns the field value as rune state'),
      { name: 'taskState', signature: 'taskState(task | asyncFn): { data, pending, settled, elapsedMs, error, run, runOnce }', desc: 'Bind an AsyncTask — or any async fn — exposing snapshot getters plus triggers.' },
    ],
    bindingSource: svelteBinding,
    bindingFile: 'packages/svelte/src/reactivity.svelte.ts',
    glueSource: svelteGlue,
    glueFile: 'examples/svelte/src/incidents.svelte.ts',
    viewSource: svelteView,
    viewFile: 'examples/svelte/src/App.svelte',
    viewLanguage: 'svelte',
    notes: [
      'Bindings live in a .svelte.ts module so $state/$effect runes compile outside components.',
    ],
  },
  {
    id: 'angular',
    name: 'Angular',
    port: 4201,
    binding: '@jwhenry123/mesh-angular',
    summary:
      'Signal adapter for zoneless Angular. Call in an injection context (field initializer or constructor) so subscriptions release on destroy. NgModule apps get the same pools through MeshModule — the NestJS binding\'s forRoot/registerPool vocabulary.',
    apis: [
      { name: 'provideMesh', signature: 'provideMesh({ pools: MeshPoolDeclaration[] })', desc: 'Register worker pools or connectWorker clients ({ name, client }) as environment providers — terminated on injector destroy.' },
      { name: 'injectMeshPool', signature: 'injectMeshPool<T>(name): T', desc: 'Inject a pool registered by provideMesh inside an injection context.' },
      { name: 'MeshModule', signature: 'MeshModule.forRoot({pools?}) / forRootAsync / registerPool(decl) / registerPoolAsync', desc: 'NgModule alternative to provideMesh — same pool tokens + lifecycle, declared on the importing module; async forms resolve their factory before bootstrap.' },
      { name: 'InjectMeshPool', signature: '@InjectMeshPool(name)', desc: 'Constructor-parameter decorator form of injectMeshPool for @Injectable() classes.' },
      { name: 'observableSignal', signature: 'observableSignal(source: ObservableValue<T>): Signal<T>', desc: 'Subscribe to any observable snapshot (task or field).' },
      VALUE_API('sharedValue', 'sharedValue(memory, key): Signal<T | undefined>', 'returns the field value as a Signal'),
      { name: 'taskState', signature: 'taskState(task | asyncFn): { state: Signal<TaskSnapshot>, run, runOnce }', desc: 'Bind an AsyncTask — or any async fn — to a Signal and get its triggers.' },
    ],
    moduleSnippet: {
      title: 'NgModule form — MeshModule',
      blurb:
        'Apps still on NgModule bootstrap register the same pools through MeshModule — forRoot once at the root, registerPool inside the feature module that owns the worker. Async forms await their factory (fed by injected deps) before bootstrap completes.',
      file: 'app.module.ts',
      code: `@NgModule({
  imports: [
    MeshModule.forRoot(),       // or forRoot({ pools: [{ name: 'incidents', client: incidents }] })
    IncidentsModule,            // imports MeshModule.registerPool({ name: 'incidents', client: incidents })
  ],
})
export class AppModule {}

@Injectable()
export class IncidentsService {
  // parameter-decorator form of injectMeshPool
  constructor(@InjectMeshPool('incidents') private readonly pool: IncidentsClient) {}
}`,
    },
    bindingSource: angularBinding,
    bindingFile: 'packages/angular/src/index.ts',
    glueSource: angularGlue,
    glueFile: 'examples/angular/src/app.component.ts',
    viewSource: angularView,
    viewFile: 'examples/angular/src/app.component.html',
    viewLanguage: 'xml',
    notes: [
      'Composition happens right in the component: signals for fields, an effect() to re-run the page query.',
      'Works with OnPush + zoneless change detection out of the box.',
    ],
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    port: 3001,
    binding: '@jwhenry123/mesh-nextjs',
    summary:
      'React re-export for App Router apps — the same hooks, packaged so client components import them under a \'use client\' boundary while server components never touch Worker.',
    apis: [
      { name: 'useObservable', signature: 'useObservable(source: ObservableValue<T>): T', desc: 'Subscribe to any observable snapshot (task or field).' },
      VALUE_API('useSharedValue', 'useSharedValue(memory, key): T | undefined', 'returns the field value as React state'),
      { name: 'useTask', signature: 'useTask(task | asyncFn): { data, pending, settled, elapsedMs, error, run, runOnce }', desc: 'Bind an AsyncTask — or any async fn (e.g. a client method) — to state and get its triggers.' },
    ],
    bindingSource: nextjsBinding,
    bindingFile: 'packages/nextjs/src/index.ts',
    glueSource: nextjsGlue,
    glueFile: 'examples/nextjs/src/useIncidents.ts',
    viewSource: nextjsView,
    viewFile: 'examples/nextjs/src/IncidentsApp.tsx',
    viewLanguage: 'tsx',
    notes: [
      'Components using the hooks carry the \'use client\' directive — IncidentsApp is the boundary; app/page.tsx stays a server component that just renders it.',
      'Importing the connectWorker client is SSR-safe: the pool spawns lazily on the first method call, never during a server render.',
      'The COOP/COEP headers() in next.config.ts are only needed because this pool uses sharedMemory — a message-only pool needs neither the headers nor SharedArrayBuffer.',
    ],
  },
];
