import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

const r = (p: string) => fileURLToPath(new URL(`./${p}`, import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [
      // Compiles `*.svelte.ts` rune modules (the svelte binding + example
      // data layer) so tests exercise the real reactive primitives. Vitest's
      // node environment reports consumer='server', which makes the plugin
      // compile runes as SSR stubs (effects never run) — force client output.
      svelte({
        dynamicCompileOptions: () => ({ generate: 'client' }),
      }),
    ],
    resolve: {
      alias: [
        // Tests exercise the package sources directly, not dist builds.
        { find: /^@jwhenry123\/mesh$/, replacement: r('src/sdk/index.ts') },
        { find: /^@jwhenry123\/mesh\/sdk$/, replacement: r('src/sdk/index.ts') },
        { find: /^@jwhenry123\/mesh\/sdk\/(.*)$/, replacement: r('src/sdk') + '/$1' },
        { find: /^@jwhenry123\/mesh-node$/, replacement: r('packages/node/src/index.ts') },
        { find: /^@jwhenry123\/mesh-node\/(.*)$/, replacement: r('packages/node/src') + '/$1' },
        { find: /^@jwhenry123\/mesh-nestjs$/, replacement: r('packages/nestjs/src/index.ts') },
        { find: /^@jwhenry123\/mesh-nestjs\/(.*)$/, replacement: r('packages/nestjs/src') + '/$1' },
        { find: /^@jwhenry123\/mesh-incidents$/, replacement: r('packages/incidents/src/index.ts') },
        { find: /^@jwhenry123\/mesh-incidents\/(.*)$/, replacement: r('packages/incidents/src') + '/$1' },
        { find: /^@jwhenry123\/mesh-worker-dom$/, replacement: r('packages/worker-dom/src/index.ts') },
        { find: /^@jwhenry123\/mesh-worker-dom\/(.*)$/, replacement: r('packages/worker-dom/src') + '/$1' },
        { find: /^@jwhenry123\/mesh-react-island$/, replacement: r('packages/react-island/src/index.tsx') },
        // The published exports map lacks ./incidents/*; tests reach worker
        // entries directly so worker-entry modules can be imported in-process.
        { find: /^@jwhenry123\/mesh\/incidents\/(.*)$/, replacement: r('packages/incidents/src') + '/$1' },
        {
          find: /^@jwhenry123\/mesh-(react|vue|solidjs|svelte|angular|nextjs)$/,
          replacement: r('packages') + '/$1/src/index.ts',
        },
        // Tests need the client build — the server build resolved under Node
        // has intentionally non-reactive primitives (effects never run).
        { find: 'solid-js', replacement: r('node_modules/solid-js/dist/solid.js') },
        { find: /^svelte$/, replacement: r('node_modules/svelte/src/index-client.js') },
        // Examples carry their own framework installs; pin every test to the
        // root copy so a component and its binding share one reactive runtime
        // (otherwise react's dispatcher / angular's injection context split).
        { find: /^react$/, replacement: r('node_modules/react') },
        { find: /^react\/(.*)$/, replacement: r('node_modules/react') + '/$1' },
        { find: /^react-dom(\/.*)?$/, replacement: r('node_modules/react-dom') + '$1' },
        { find: /^vue(\/.*)?$/, replacement: r('node_modules/vue') + '$1' },
        // Deep-import aliases must hit concrete files — rewriting to a path
        // bypasses the package's exports map.
        { find: /^@angular\/core\/testing$/, replacement: r('node_modules/@angular/core/fesm2022/testing.mjs') },
        {
          find: /^@angular\/platform-browser-dynamic\/testing$/,
          replacement: r('node_modules/@angular/platform-browser-dynamic/fesm2022/testing.mjs'),
        },
        { find: /^@angular\/(.*)$/, replacement: r('node_modules/@angular') + '/$1' },
      ],
    },
    test: {
      // Browser examples run their seed/scan pipeline in-process — larger
      // buffers and e2e app builds need headroom beyond the 5s default.
      testTimeout: 30_000,
      hookTimeout: 120_000,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        // The publishable surface: core sdk + every mesh-* binding package.
        include: ['src/sdk/**', 'packages/*/src/**'],
        exclude: ['**/*.test.*', '**/test/**'],
      },
    },
  })
);
