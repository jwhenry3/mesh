import { useEffect, useState, type ReactNode } from 'react';
import { SiteSwitch } from './components/SiteSwitch';
import { FRAMEWORKS } from './frameworks';
import { FRAMEWORK_PAGES } from './frameworkPages';
import { FrameworkPage } from './pages/FrameworkPage';
import { Hosting } from './pages/Hosting';
import { Nestjs } from './pages/Nestjs';
import { Overview } from './pages/Overview';
import { Quickstart } from './pages/Quickstart';
import { Reactivity } from './pages/Reactivity';
import { SharedMemoryApi } from './pages/SharedMemoryApi';
import { SharedWorker } from './pages/SharedWorker';
import { TasksAndPool } from './pages/TasksAndPool';

interface Route {
  id: string;
  label: string;
  page: () => ReactNode;
  /** Sub-pages — rendered indented under this link in the sidebar. */
  children?: Route[];
}

const SECTIONS: { label: string; routes: Route[] }[] = [
  {
    label: 'Getting started',
    routes: [
      { id: 'overview', label: 'Overview', page: () => <Overview /> },
      { id: 'quickstart', label: 'Quickstart', page: () => <Quickstart /> },
    ],
  },
  {
    label: 'API',
    routes: [
      { id: 'shared-memory', label: 'Shared memory', page: () => <SharedMemoryApi /> },
      { id: 'tasks', label: 'Worker pool & tasks', page: () => <TasksAndPool /> },
      { id: 'reactivity', label: 'Reactivity', page: () => <Reactivity /> },
      { id: 'shared-worker', label: 'Shared worker', page: () => <SharedWorker /> },
    ],
  },
  {
    label: 'Frameworks',
    routes: [
      ...FRAMEWORKS.map((fw) => ({
        id: `fw-${fw.id}`,
        label: fw.name,
        page: () => <FrameworkPage key={fw.id} fw={fw} />,
        // Framework-specific sub-pages opt in via FRAMEWORK_PAGES — see
        // frameworkPages.tsx (React gets the worker-islands page).
        children: FRAMEWORK_PAGES[fw.id]?.map((sub) => ({
          id: `fw-${fw.id}/${sub.id}`,
          label: sub.label,
          page: sub.page,
        })),
      })),
      { id: 'fw-nestjs', label: 'NestJS', page: () => <Nestjs /> },
    ],
  },
  {
    label: 'Deployment',
    routes: [{ id: 'hosting', label: 'Hosting & headers', page: () => <Hosting /> }],
  },
];

const allRoutes = SECTIONS.flatMap((s) => s.routes.flatMap((r) => [r, ...(r.children ?? [])]));

function useHashRoute() {
  const [route, setRoute] = useState(() => window.location.hash.slice(2) || 'overview');
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(2) || 'overview');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  const route = useHashRoute();
  const active = allRoutes.find((r) => r.id === route) ?? allRoutes[0];

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/overview">
          mesh<span className="brand-sub">package docs</span>
        </a>
        <SiteSwitch current="consumer" />
        {SECTIONS.map((section) => (
          <nav key={section.label} className="nav-section">
            <h3>{section.label}</h3>
            {section.routes.map((r) => (
              <span key={r.id} style={{ display: 'contents' }}>
                <a
                  href={`#/${r.id}`}
                  className={r.id === active.id ? 'nav-link active' : 'nav-link'}
                >
                  {r.label}
                </a>
                {r.children?.map((sub) => (
                  <a
                    key={sub.id}
                    href={`#/${sub.id}`}
                    className={
                      sub.id === active.id
                        ? 'nav-link nav-sublink active'
                        : 'nav-link nav-sublink'
                    }
                  >
                    {sub.label}
                  </a>
                ))}
              </span>
            ))}
          </nav>
        ))}
      </aside>
      <main className="content">{active.page()}</main>
    </div>
  );
}
