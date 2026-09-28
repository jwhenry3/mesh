import { useEffect, useState, type ReactNode } from 'react';
import { SiteSwitch } from './components/SiteSwitch';
import { FRAMEWORKS } from './frameworks';
import { FRAMEWORK_PAGES } from './frameworkPages';
import { FrameworkPage } from './pages/FrameworkPage';
import { Isolation } from './pages/Isolation';
import { Nestjs } from './pages/Nestjs';
import { Overview } from './pages/Overview';
import { Playground } from './pages/Playground';
import { Reactivity } from './pages/Reactivity';
import { SharedMemory } from './pages/SharedMemory';
import { SharedWorker } from './pages/SharedWorker';
import { TasksAndPool } from './pages/TasksAndPool';

export interface Route {
  id: string;
  label: string;
  page: () => ReactNode;
  /** Sub-pages — rendered indented under this link in the sidebar. */
  children?: Route[];
}

/**
 * Framework sections are data-driven: FRAMEWORKS gives one overview page per
 * framework; FRAMEWORK_PAGES adds framework-specific sub-pages (worker
 * islands for React today — any framework can opt in by adding entries).
 * Route ids stay flat hash routes (`fw-react`, `fw-react/worker-islands`…).
 */
const frameworkRoutes: Route[] = FRAMEWORKS.map((fw) => ({
  id: `fw-${fw.id}`,
  label: fw.name,
  page: () => <FrameworkPage key={fw.id} fw={fw} />,
  children: FRAMEWORK_PAGES[fw.id]?.map((sub) => ({
    id: `fw-${fw.id}/${sub.id}`,
    label: sub.label,
    page: sub.page,
  })),
}));

const SECTIONS: { label: string; routes: Route[] }[] = [
  {
    label: 'Getting started',
    routes: [{ id: 'overview', label: 'Overview', page: () => <Overview /> }],
  },
  {
    label: 'Core concepts',
    routes: [
      { id: 'shared-memory', label: 'Shared memory', page: () => <SharedMemory /> },
      { id: 'tasks', label: 'Worker pool & tasks', page: () => <TasksAndPool /> },
      { id: 'reactivity', label: 'Reactivity & tasks', page: () => <Reactivity /> },
      { id: 'shared-worker', label: 'Shared worker', page: () => <SharedWorker /> },
      { id: 'isolation', label: 'Cross-origin isolation', page: () => <Isolation /> },
    ],
  },
  {
    label: 'Frameworks',
    routes: [
      ...frameworkRoutes,
      { id: 'fw-nestjs', label: 'NestJS', page: () => <Nestjs /> },
    ],
  },
  {
    label: 'Demos',
    routes: [{ id: 'playground', label: 'Live playground', page: () => <Playground /> }],
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

const NavLink = ({ route, active }: { route: Route; active: string }) => (
  <a
    href={`#/${route.id}`}
    className={route.id === active ? 'nav-link active' : 'nav-link'}
  >
    {route.label}
  </a>
);

export function App() {
  const route = useHashRoute();
  const active = allRoutes.find((r) => r.id === route) ?? allRoutes[0];

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/overview">
          mesh<span className="brand-sub">sdk docs</span>
        </a>
        <SiteSwitch current="sdk" />
        {SECTIONS.map((section) => (
          <nav key={section.label} className="nav-section">
            <h3>{section.label}</h3>
            {section.routes.map((r) => (
              <span key={r.id} style={{ display: 'contents' }}>
                <NavLink route={r} active={active.id} />
                {r.children?.map((sub) => (
                  <a
                    key={sub.id}
                    href={`#/${sub.id}`}
                    className={
                      sub.id === active.id ? 'nav-link nav-sublink active' : 'nav-link nav-sublink'
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
