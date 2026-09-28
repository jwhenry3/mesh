// Builds the docs sites + static framework examples, then assembles the
// GitHub Pages artifact in dist-pages/ (see assemble-pages.mjs).
// Usage: node scripts/build-pages.mjs [--no-build]
import { fileURLToPath } from 'node:url';
import { npmCmd, npmScript, runStep, stop } from './orchestrate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const assemble = fileURLToPath(new URL('assemble-pages.mjs', import.meta.url));

const projects = [
  ['docs', 'docs'],
  ['docs-consumer', 'docs-consumer'],
  ['react', 'examples/react'],
  ['vue', 'examples/vue'],
  ['solid', 'examples/solid'],
  ['svelte', 'examples/svelte'],
  ['angular', 'examples/angular'],
  ['react-dom-worker', 'examples/react-dom-worker'],
];

if (!process.argv.includes('--no-build')) {
  for (const [name, cwd] of projects) {
    try {
      await runStep(`${name}:build`, cwd, npmCmd, npmScript('build'));
    } catch (error) {
      console.error(error.message);
      stop(1);
    }
  }
}

try {
  await runStep('assemble:pages', root, process.execPath, [assemble]);
} catch (error) {
  console.error(error.message);
  stop(1);
}
console.log('build-pages: dist-pages/ is ready for upload');
