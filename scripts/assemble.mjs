// Copies each built app into dist/<name>/ under the root dist, so one static
// server can reach every app's index.html by path:
//   /            root dashboard (dist/index.html)
//   /sdk/        docs site        /consumer/   docs-consumer site
//   /react/ /vue/ /solid/ /svelte/ /angular/   framework examples
// (Next.js is server-rendered — it isn't copied; `next start` serves it.)
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

const mounts = [
  ['sdk', 'docs/dist'],
  ['consumer', 'docs-consumer/dist'],
  ['react', 'examples/react/dist'],
  ['vue', 'examples/vue/dist'],
  ['solid', 'examples/solid/dist'],
  ['svelte', 'examples/svelte/dist'],
  ['angular', 'examples/angular/dist/incidents-angular/browser'],
  // Multi-page build: dist holds index.html (framework-free shell) AND
  // react-shell.html (React + <Island/> proxies) side by side.
  ['react-dom-worker', 'examples/react-dom-worker/dist'],
];

if (!existsSync(join(root, 'dist/index.html'))) {
  console.error('assemble: dist/index.html missing — build the root app first');
  process.exit(1);
}

for (const [name, dir] of mounts) {
  const src = join(root, dir);
  const dest = join(root, 'dist', name);
  if (!existsSync(src)) {
    console.error(`assemble: ${dir} missing — build ${name} first`);
    process.exit(1);
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  console.log(`mounted ${dir} -> dist/${name}/`);
}

// The docs sites embed the framework demos via relative ./<id>/ iframe URLs,
// so each docs mount also gets its own copy of the demo builds.
const docsSites = ['sdk', 'consumer'];
const demoDirs = mounts.filter(([name]) => !docsSites.includes(name));
for (const site of docsSites) {
  for (const [name, dir] of demoDirs) {
    const src = join(root, dir);
    const dest = join(root, 'dist', site, name);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
  }
  console.log(`mounted demos -> dist/${site}/<name>/`);
}
