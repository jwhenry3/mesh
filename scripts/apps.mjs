// Single source of truth for the app spec: [name, project dir, port].
// Used by dev-all, kill-all, and the port preflight in serve-all.
export const apps = [
  ['root', '.', 4173],
  ['docs', 'docs', 4180],
  ['consumer-docs', 'docs-consumer', 4181],
  ['react', 'examples/react', 5173],
  ['vue', 'examples/vue', 5174],
  ['solid', 'examples/solid', 5175],
  ['svelte', 'examples/svelte', 5176],
  ['angular', 'examples/angular', 4201],
  ['nextjs', 'examples/nextjs', 3001],
  ['nestjs', 'examples/nestjs', 3100],
  ['react-dom-worker', 'examples/react-dom-worker', 5177],
];
