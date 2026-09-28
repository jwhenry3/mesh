// Embedded sources — ?raw inlines the real files so the docs always show
// the code that ships in this repo.
import workerEntry from '../../../examples/react-dom-worker/src/worker/render.worker.ts?raw';
import shellSource from '../../../examples/react-dom-worker/src/shell.tsx?raw';
import { CodeBlock } from '../components/CodeBlock';
import { DemoFrame } from '../components/DemoFrame';

/**
 * Worker islands under the React framework — the react-dom-worker example's
 * React shell (`react-shell.html`), where every island mounts through a
 * lazyIsland proxy: the worker-hosted component types like a local one.
 */
export function ReactWorkerIslands() {
  return (
    <article>
      <h1>React — worker islands</h1>
      <p className="lead">
        <code>@jwhenry123/mesh-react-island</code> — a worker-hosted React (or
        imperative proxy-DOM) tree mounted as an ordinary element in a React shell.
        The worker's render loop produces serialized DOM ops; the main thread just
        replays them.
      </p>

      <h2>Live demo — React shell</h2>
      <p>
        Seven islands across three topologies — the React apps ride a registry
        worker (the two data-tables share ONE client, two realms in one worker),
        the imperative islands get dedicated realm workers bundling only their
        own deps. Every mount below is a <code>lazyIsland</code> proxy wrapped in{' '}
        <code>&lt;Suspense&gt;</code>.
      </p>
      <DemoFrame
        id="react-dom-worker"
        port={5177}
        name="react-dom-worker — React shell"
        path="/react-shell.html"
      />
      <p className="demo-hint">
        The same islands under a zero-React shell live at{' '}
        <code>react-dom-worker/index.html</code> — proof the op protocol doesn't
        care what the shell is made of.
      </p>

      <h2>The proxy API</h2>
      <table className="doc-table">
        <thead>
          <tr><th>Export</th><th>Signature</th><th>What it does</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>lazyIsland</code></td>
            <td><code>lazyIsland(loader: () =&gt; Promise&lt;{'{'} default: A {'}'} | A&gt;): FC&lt;IslandAppProps&lt;A&gt; &amp; IslandShellProps&gt;</code></td>
            <td>
              React.lazy mirrored — the returned component suspends on the dynamic
              import (a real bundler split point), then mounts the stamped app by
              reference with props inferred from its signature.
            </td>
          </tr>
          <tr>
            <td><code>islandComponent</code></td>
            <td><code>islandComponent&lt;P&gt;('name') | islandComponent(StampedApp)</code></td>
            <td>
              The pure-contract proxy — the shell never imports the implementation;
              a registry key + a type-only props import is the whole contract.
            </td>
          </tr>
          <tr>
            <td><code>Island</code></td>
            <td><code>&lt;Island app={'{'}ref|name{'}'} worker props onEvent slots onReady/&gt;</code></td>
            <td>
              The underlying building block — declarative mountIsland as a
              component. <code>props</code> dedups by serialized identity.
            </td>
          </tr>
          <tr>
            <td><code>islandApp</code></td>
            <td><code>islandApp('name', app)</code></td>
            <td>
              Stamps an app (component or {'{'}imperative{'}'} def) with its registry
              name — a data property, so references survive minification.
            </td>
          </tr>
          <tr>
            <td><code>defineIslandWorker</code></td>
            <td><code>defineIslandWorker({'{'} apps {'}'})</code></td>
            <td>
              Registry worker — one script serving a whole apps map; islands
              mount by name and several may share one client/worker.
            </td>
          </tr>
          <tr>
            <td><code>defineRealmWorker</code></td>
            <td><code>defineRealmWorker(app)</code></td>
            <td>
              Realm worker — the 1:1 topology: one script, one app, mounted
              namelessly. Its bundle carries only that app's dependencies.
            </td>
          </tr>
          <tr>
            <td><code>Slot / emit</code></td>
            <td><code>&lt;Slot name&gt; / emit(name, payload)</code></td>
            <td>
              Transclusion: worker markup hands a real element to the shell's
              slots map (canvases, Monaco, AG Grid). emit is the island→shell
              event channel.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Mounting — the proxies make islands look local</h2>
      <p>
        Each <code>lazyIsland</code> loader returns the <code>islandApp</code>-stamped
        component, so props infer from the worker component's own signature and the
        dynamic import code-splits worker dependencies (recharts fetches only when
        the charts island mounts). <code>&lt;Suspense&gt;</code> covers the module
        load; the proxy's <code>fallback</code> prop covers the worker-mount window —
        mounting can't suspend because a suspended tree never commits and the
        container must be in the DOM first.
      </p>
      <CodeBlock
        file="examples/react-dom-worker/src/shell.tsx"
        language="tsx"
        code={shellSource}
      />

      <h2>The worker side — two topologies</h2>
      <p>
        <b>Registry workers</b> (<code>defineIslandWorker</code>) serve a whole
        apps map from one script — the React islands mount by name, and the two
        data-table islands share ONE client so both realms live in a single
        worker (separate reconcilers, op queues, and pids — one OS thread).
        <b>Realm workers</b> (<code>defineRealmWorker</code>) are the 1:1 form —
        one script per app, mounted namelessly, bundling only that app's
        dependencies (map/vanilla shed recharts and the other React apps; the
        shared worker chunk still carries the reconciler).
      </p>
      <CodeBlock
        file="examples/react-dom-worker/src/worker/render.worker.ts"
        code={workerEntry}
      />

      <h2>Notes</h2>
      <ul>
        <li>
          <b>Mediation is unidirectional</b> — an island's <code>emit</code> lands in{' '}
          <code>onEvent</code>, the shell sets state, and it flows back in as props.
          No hand-wired <code>updateProps</code> calls.
        </li>
        <li>
          <b>Two fallback phases:</b> <code>&lt;Suspense&gt;</code> for the module
          load, the proxy's <code>fallback</code> prop for the worker mount.
        </li>
        <li>
          <b>Fixed-dimension libs</b> (recharts) get width/height as props —
          there's no ResizeObserver channel into the worker; measurement reads on
          the proxy DOM return zero.
        </li>
        <li>
          <b>Structural walls stay walls:</b> closed libraries that need real DOM
          (Google Maps JS) are housed via transclusion slots or iframe elements —
          the worker owns the box, the shell owns the contents.
        </li>
      </ul>
    </article>
  );
}
