import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The sdk and the worker-dom package live in the workspace root — alias the
// package names to their sources so the example runs against them without a
// build step. (The file: dependency in package.json would also resolve, but
// aliases make dev/test robust regardless of install state.)
const sdkRoot = fileURLToPath(new URL('../../src/sdk/', import.meta.url)).replace(/\\/g, '/');
const workerDomRoot = fileURLToPath(new URL('../../packages/worker-dom/src/', import.meta.url)).replace(/\\/g, '/');

export default defineConfig(({ command }) => ({
  // Built output is mounted at /react-dom-worker/ under the unified dist root; dev serves /.
  base: command === 'build' ? '/react-dom-worker/' : '/',
  resolve: {
    // react-reconciler resolves `react` through its peer dep — without dedupe
    // the worker could bundle two React copies and hooks would read a null
    // dispatcher. Force a single copy for the whole example.
    dedupe: ['react'],
    alias: [
      { find: /^@jwhenry123\/mesh$/, replacement: `${sdkRoot}index.ts` },
      { find: /^@jwhenry123\/mesh\/sdk$/, replacement: `${sdkRoot}index.ts` },
      { find: /^@jwhenry123\/mesh\/sdk\//, replacement: sdkRoot },
      { find: /^@jwhenry123\/mesh-worker-dom$/, replacement: `${workerDomRoot}index.ts` },
      { find: /^@jwhenry123\/mesh-worker-dom\/worker$/, replacement: `${workerDomRoot}worker/index.ts` },
      {
        find: /^@jwhenry123\/mesh-react-island$/,
        replacement: `${fileURLToPath(new URL('../../packages/react-island/src/', import.meta.url)).replace(/\\/g, '/')}index.tsx`,
      },
    ],
  },
  // Two entry pages: index.html is the framework-free shell (src/main.ts),
  // react-shell.html is the same islands mounted by a React shell through
  // <Island/> (src/shell.tsx).
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        'react-shell': fileURLToPath(new URL('./react-shell.html', import.meta.url)),
      },
    },
  },
  // The ops themselves still ride postMessage — but the push transport uses
  // a SharedArrayBuffer doorbell (see packages/worker-dom memory.ts), which
  // requires cross-origin isolation. Poll mode needs none of this — that's
  // the tradeoff the toolbar lets you feel.
  server: {
    fs: { allow: ['../..'] },
    port: 5177,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      // credentialless, not require-corp: it still grants
      // crossOriginIsolated (SharedArrayBuffer doorbell works) but lets
      // no-cors cross-origin subresources load without CORP headers — the
      // map island's OSM tile <img>s come from tile.openstreetmap.org.
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
}));
