/**
 * A transclusion slot — renders a leaf element marked `data-mesh-slot`.
 * The element's BOX belongs to this worker tree (layout/style ops apply as
 * usual); its CONTENTS belong to the shell: when the create op lands on the
 * main thread, the island's `slots[name]` callback gets the real element
 * and can mount anything inside — a canvas, Monaco, a main-thread React
 * root — all real DOM with real events and zero wire traffic.
 *
 * Must stay a LEAF in this tree: if worker-side children were appended here
 * their ops would interleave with shell-owned content. There is also no
 * measurement channel — the island knows the box it laid out, not the
 * pixel size the shell put inside it.
 */
import type { ReactElement } from 'react';

export function Slot({ name, style }: { name: string; style?: Record<string, unknown> }): ReactElement {
  return <div data-mesh-slot={name} style={style} />;
}
