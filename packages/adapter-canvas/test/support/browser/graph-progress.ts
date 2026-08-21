// Readers for the shared graph build progress panel.
//
// The panel is built imperatively by src/browser/graph/progress.ts, so its parts
// are nested below the host element rather than registered as ids the fake
// document can resolve. These walkers keep every graph page suite reading the
// panel the same way, and keep the assertions about behavior rather than about
// markup shape.

import { fakeText } from "./fakes.js";
import type { FakeElement } from "./fakes.js";

const STAGE_PREFIX = "rad-graph-progress__stage--";

function find(root: FakeElement, className: string): FakeElement | null {
  if (root.className.split(" ").includes(className)) return root;
  for (const child of root.children) {
    const match = find(child, className);
    if (match) return match;
  }
  return null;
}

function stageState(row: FakeElement): string {
  const modifier = row.className
    .split(" ")
    .find((name) => name.startsWith(STAGE_PREFIX));
  return modifier ? modifier.slice(STAGE_PREFIX.length) : "";
}

// One "label:state" entry per stage row, in render order.
export function graphProgressStages(host: FakeElement): string[] {
  const list = find(host, "rad-graph-progress__stages");
  return (list?.children ?? []).map((row) => {
    const [label = ""] = fakeText(row).split(" — ");
    return `${label.replace(/^[^A-Za-z]+/, "")}:${stageState(row)}`;
  });
}

export function graphProgressElapsed(host: FakeElement): string {
  const elapsed = find(host, "rad-graph-progress__elapsed");
  return elapsed ? fakeText(elapsed) : "";
}

export function graphProgressTitle(host: FakeElement): string {
  const title = find(host, "rad-graph-progress__title");
  return title ? fakeText(title) : "";
}

export function graphProgressActivity(host: FakeElement): FakeElement | null {
  return find(host, "rad-graph-progress__activity");
}

export function graphProgressPanel(host: FakeElement): FakeElement | null {
  return find(host, "rad-graph-progress");
}
