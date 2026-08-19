// Canvas adapter — the shared graph build progress view.
//
// Every graph page (modeled, planned, diff, deployed) reports the same thing:
// which stage of a multi-step build is running, what it is doing, and how long
// it has been going. That is rendered here once so the four pages stay
// consistent, and so the honesty rule has a single home: progress comes from
// typed server events plus real elapsed time. Nothing here invents a
// completion percentage, a progress bar or an estimated finish time, because
// the server cannot know how long compiling a model or resolving recipes will
// take.
//
// Events arrive by polling `/api/progress`, which races the workflow request
// that produces them, so ordering is enforced rather than assumed. See sync().

import { buildElement } from "../dom.js";
import { isRecord, readNumber, readString } from "../json.js";
import type { ElementSpec } from "../dom.js";
import type { EntryScope } from "../lifecycle.js";
import type { BrowserContext, DomElement } from "../ports.js";

export const GRAPH_PROGRESS_STEPS_ID = "progress-steps";
export const GRAPH_PROGRESS_TICK_MS = 1000;

export type GraphBuildStage =
  | "checking_model"
  | "creating_model"
  | "building_graph"
  | "building_base_graph"
  | "building_head_graph"
  | "resolving_recipes"
  | "loading_deployment"
  | "comparing_graphs"
  | "rendering_graph";

export type GraphBuildEventState = "running" | "succeeded" | "failed";

export interface GraphBuildEvent {
  readonly sequence: number;
  readonly stage: GraphBuildStage;
  readonly state: GraphBuildEventState;
  readonly detail: string;
}

// The user-facing name of each stage. A payload naming a stage absent from this
// map is ignored rather than rendered raw, so a newer server cannot inject an
// unlabeled row into an older panel.
export const GRAPH_STAGE_LABELS: Readonly<Record<GraphBuildStage, string>> = {
  checking_model: "Check for an application model",
  creating_model: "Create .radius/app.bicep",
  building_graph: "Build the resource graph",
  building_base_graph: "Build the base graph",
  building_head_graph: "Build the head graph",
  resolving_recipes: "Resolve deployment recipes",
  loading_deployment: "Load deployed resources",
  comparing_graphs: "Compare application graphs",
  rendering_graph: "Render the application graph"
};

const STATE_CLASS: Readonly<Record<GraphBuildEventState, string>> = {
  running: "step-active",
  succeeded: "step-done",
  failed: "step-error"
};

function isStage(value: string): value is GraphBuildStage {
  return Object.prototype.hasOwnProperty.call(GRAPH_STAGE_LABELS, value);
}

function isEventState(value: string): value is GraphBuildEventState {
  return value === "running" || value === "succeeded" || value === "failed";
}

// Narrow one untrusted payload entry. Anything missing a known stage or a known
// state is dropped, so a malformed or partial response cannot blank the panel
// or render an unrecognized row.
export function parseGraphBuildEvent(value: unknown): GraphBuildEvent | null {
  if (!isRecord(value)) return null;
  const stage = readString(value, "stage");
  const state = readString(value, "state");
  if (!isStage(stage) || !isEventState(state)) return null;
  return {
    sequence: readNumber(value, "sequence") ?? 0,
    stage,
    state,
    detail: readString(value, "detail")
  };
}

export function parseGraphBuildEvents(
  values: readonly unknown[]
): GraphBuildEvent[] {
  const events: GraphBuildEvent[] = [];
  for (const value of values) {
    const event = parseGraphBuildEvent(value);
    if (event) events.push(event);
  }
  return events;
}

export function formatGraphElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ?
      `Elapsed ${minutes}m ${seconds}s`
    : `Elapsed ${seconds}s`;
}

export interface GraphProgressView {
  // Apply a server snapshot. `generation` identifies the stream that produced
  // it; snapshots from a superseded stream are ignored.
  sync(events: readonly unknown[], generation: number): void;
  // Record a stage the client observed directly, such as the terminal outcome
  // carried by the workflow response rather than by the progress stream.
  append(
    stage: GraphBuildStage,
    state: GraphBuildEventState,
    detail: string
  ): void;
  // Freeze the panel: the elapsed clock stops and nothing may repaint it.
  stop(): void;
  readonly stopped: boolean;
  events(): readonly GraphBuildEvent[];
}

export interface GraphProgressOptions {
  readonly hostId?: string;
  readonly initial?: GraphBuildEvent;
}

// Build the progress view for one graph request. The elapsed timer belongs to
// the caller's entry scope, so page teardown or navigation stops it without the
// page having to remember to.
export function createGraphProgress(
  context: BrowserContext,
  scope: EntryScope,
  options: GraphProgressOptions = {}
): GraphProgressView {
  const hostId = options.hostId ?? GRAPH_PROGRESS_STEPS_ID;
  const startedAtMs = context.clock.now();

  let events: GraphBuildEvent[] = [];
  let appliedGeneration = 0;
  let appliedSequence = 0;
  // A locally appended event carries a sequence the server never issued, so an
  // equal server sequence is stale rather than newer.
  let localAhead = false;
  let stopped = false;
  // Retained so the one-second tick can update the clock in place. Re-rendering
  // the panel every second would keep replacing the aria-live detail node and
  // make a screen reader repeat the stage on every tick.
  let elapsedElement: DomElement | null = null;

  const host = (): DomElement | null => context.dom.byId(hostId);

  const elapsedText = (): string =>
    formatGraphElapsed(context.clock.now() - startedAtMs);

  const render = (): void => {
    const container = host();
    if (!container) return;
    const latest = events.at(-1) ?? null;
    // One row per stage, showing that stage's most recent state, in the order
    // the build first reached them.
    const latestByStage = new Map<GraphBuildStage, GraphBuildEvent>();
    for (const event of events) latestByStage.set(event.stage, event);

    const steps: ElementSpec[] = [];
    for (const [stage, event] of latestByStage) {
      steps.push({
        tag: "li",
        className: STATE_CLASS[event.state],
        text: GRAPH_STAGE_LABELS[stage]
      });
    }

    elapsedElement = buildElement(context.dom, {
      tag: "span",
      className: "rad-graph-progress__elapsed",
      attrs: { style: "font-size:12px;" },
      text: elapsedText()
    });
    const statusRow = buildElement(context.dom, {
      tag: "div",
      className: "rad-graph-progress__status",
      attrs: {
        style:
          "display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px;"
      },
      children: [
        {
          tag: "strong",
          className: "rad-graph-progress__stage",
          attrs: { style: "color:var(--rad-text);" },
          text: latest ? GRAPH_STAGE_LABELS[latest.stage] : ""
        }
      ]
    });
    statusRow.appendChild(elapsedElement);

    const rest: ElementSpec[] = [
      {
        // Announced politely so a screen reader follows the build without the
        // stage list being re-read on every poll.
        tag: "div",
        className: "rad-graph-progress__detail",
        attrs: {
          role: "status",
          "aria-live": "polite",
          style: "color:var(--rad-text); margin-bottom:10px;"
        },
        text: latest?.detail ?? ""
      },
      {
        tag: "ul",
        className: "rad-graph-progress__steps",
        attrs: {
          "aria-label": "Graph build stages",
          style: "list-style:none; margin:0; padding:0;"
        },
        children: steps
      }
    ];
    container.replaceChildren(
      statusRow,
      ...rest.map((spec) => buildElement(context.dom, spec))
    );
  };

  const timer = scope.every(GRAPH_PROGRESS_TICK_MS, () => {
    if (stopped || !elapsedElement) return;
    elapsedElement.textContent = elapsedText();
  });

  const view: GraphProgressView = {
    sync(nextEvents, generation) {
      if (stopped) return;
      const parsed = parseGraphBuildEvents(nextEvents);
      const nextSequence = parsed.reduce(
        (max, event) => Math.max(max, event.sequence),
        0
      );
      if (generation < appliedGeneration) {
        // A poll issued before the current stream took over. Its stages belong
        // to a build the user is no longer waiting on.
        return;
      }
      if (generation > appliedGeneration) {
        appliedGeneration = generation;
      } else if (
        nextSequence < appliedSequence ||
        (localAhead && nextSequence === appliedSequence)
      ) {
        // An older in-flight poll of this same stream. Applying it would walk
        // the panel back to a stage the build has already left.
        return;
      }
      localAhead = false;
      appliedSequence = nextSequence;
      events = parsed;
      render();
    },
    append(stage, state, detail) {
      if (stopped) return;
      const sequence =
        events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
      events = [...events, { sequence, stage, state, detail }];
      appliedSequence = sequence;
      localAhead = true;
      render();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      scope.cancel(timer);
    },
    get stopped() {
      return stopped;
    },
    events() {
      return events;
    }
  };

  if (options.initial) {
    events = [options.initial];
    appliedSequence = options.initial.sequence;
    localAhead = true;
  }
  render();

  return view;
}
