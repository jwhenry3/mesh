interface DemoFrameProps {
  id: string;
  port: number;
  name: string;
  /** Non-index page within the app — e.g. '/react-shell.html'. */
  path?: string;
}

/**
 * Embeds one of the framework example apps. In a docs dev server the examples
 * run on their own ports (npm run dev:all); in the built docs they are mounted
 * at ./<id>/ relative to the site root — works under any base path (serve:docs,
 * serve:all, GitHub Pages). Next.js is server-rendered and always runs on its own port.
 */
export function DemoFrame({ id, port, name, path = '' }: DemoFrameProps) {
  const base =
    import.meta.env.DEV || id === 'nextjs'
      ? `${window.location.protocol}//${window.location.hostname}:${port}`
      : `./${id}/`;
  // ?v=<build stamp> — index.html keeps a stable name, so a fresh stamp per
  // build forces browsers past aggressively cached documents.
  const src = `${base}${path.replace(/^\//, '')}?v=${__BUILD_ID__}`;
  const label = src.startsWith('./')
    ? `${id}/${path.replace(/^\//, '')}`
    : `${window.location.hostname}:${port}${path}`;
  return (
    <div className="demo-frame">
      <div className="demo-frame-bar">
        <span>
          live demo — <code>{name}</code>
        </span>
        <a href={src} target="_blank" rel="noreferrer">
          {label} ↗
        </a>
      </div>
      <iframe
        src={src}
        title={`${name} live demo`}
        // Let the embedded app keep cross-origin isolation so
        // SharedArrayBuffer stays available inside the frame.
        allow="cross-origin-isolated"
      />
      <p className="demo-hint">
        If the frame is blank, the examples aren't up — run{' '}
        <code>npm run dev:all</code> (dev servers) or <code>npm run serve:all</code>{' '}
        (built apps) from the repository root.
      </p>
    </div>
  );
}
