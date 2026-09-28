/**
 * Framework-specific sub-pages — keyed by FRAMEWORKS id, each entry becomes
 * a child nav route under that framework (`fw-<id>/<sub.id>`). This is the
 * seam for per-framework docs that don't fit the generic binding template:
 * React gets the worker-islands page; other frameworks opt in the same way.
 */
import type { ReactNode } from 'react';
import { ReactWorkerIslands } from './pages/ReactWorkerIslands';

export interface FrameworkSubPage {
  id: string;
  label: string;
  page: () => ReactNode;
}

export const FRAMEWORK_PAGES: Record<string, FrameworkSubPage[]> = {
  react: [
    {
      id: 'worker-islands',
      label: 'Worker islands',
      page: () => <ReactWorkerIslands />,
    },
  ],
};
