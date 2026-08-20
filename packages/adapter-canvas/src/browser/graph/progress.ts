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

const STAGE_GLYPH: Readonly<Record<GraphBuildEventState, string>> = {
  running: "◐",
  succeeded: "✓",
  failed: "✗"
};

// Fold a server snapshot into the stages already on screen. The snapshot
// decides which stages exist; the panel's memory only decides how far each of
// them has already got.
//
// A stage never walks backwards. The server restarts its event stream for every
// request, so while the page waits for Copilot to author a model each retry
// replays "checking_model running" after that stage already succeeded.
// Replaying it would flip the row from done back to running every few seconds,
// which reads as a stuck build rather than a wait. A stage the current attempt
// already saw finish cannot un-finish, so a later `running` for it is dropped.
function applyGraphSnapshot(
  current: readonly GraphBuildEvent[],
  incoming: readonly GraphBuildEvent[]
): GraphBuildEvent[] {
  const previous = new Map<GraphBuildStage, GraphBuildEvent>();
  for (const event of current) previous.set(event.stage, event);
  const byStage = new Map<GraphBuildStage, GraphBuildEvent>();
  for (const event of incoming) {
    const prior = previous.get(event.stage);
    const regressing =
      prior !== undefined &&
      prior.state !== "running" &&
      event.state === "running";
    byStage.set(event.stage, regressing ? prior : event);
  }
  return [...byStage.values()];
}

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

// Elapsed time is shown the way environment setup shows it: a plain m:ss clock
// of time actually spent, never an estimate of time remaining.
export function formatGraphElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
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
  // End the panel on the failure the caller just observed: the stage still
  // reported as running is marked failed, then the panel freezes. Stopping
  // without this leaves a stage reading "running" for work that has ended.
  fail(detail: string): void;
  // Freeze the panel: the elapsed clock stops and nothing may repaint it.
  stop(): void;
  // Repaint into the current host. A page that remounts its loading surface
  // between retries replaces the host element, so the panel has to be drawn
  // again without restarting the clock or losing the stages already reported.
  remount(): void;
  readonly stopped: boolean;
  events(): readonly GraphBuildEvent[];
}

export interface GraphProgressOptions {
  readonly hostId?: string;
  readonly initial?: GraphBuildEvent;
  readonly title?: string;
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
  const title = options.title ?? "Generating application graph";
  const startedAtMs = context.clock.now();

  let events: GraphBuildEvent[] = [];
  // The most recently applied event, which is what the activity line describes.
  // It is tracked separately because merging keeps each stage in its original
  // position, so the newest event is not necessarily the last row.
  let latestEvent: GraphBuildEvent | null = null;
  // What the panel currently shows. Polling repeats the same snapshot several
  // times per stage, and rebuilding identical markup would replace the live
  // region on every poll, making a screen reader re-announce an unchanged stage
  // and the panel visibly repaint.
  let renderedSignature: string | null = null;
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

  const render = (force = false): void => {
    const signature = JSON.stringify([
      events.map((event) => [event.stage, event.state]),
      latestEvent?.detail ?? ""
    ]);
    if (!force && signature === renderedSignature) return;
    const container = host();
    if (!container) return;
    renderedSignature = signature;
    const latest = latestEvent;
    // One row per stage, showing that stage's most recent state, in the order
    // the build first reached them.
    const stages: ElementSpec[] = [];
    for (const event of events) {
      stages.push({
        tag: "li",
        className: `rad-graph-progress__stage rad-graph-progress__stage--${event.state}`,
        children: [
          {
            tag: "span",
            className: "rad-graph-progress__glyph",
            attrs: { "aria-hidden": "true" },
            text: STAGE_GLYPH[event.state]
          },
          {
            tag: "span",
            text: `${GRAPH_STAGE_LABELS[event.stage]} — ${event.state}`
          }
        ]
      });
    }

    const failed = latest?.state === "failed";
    elapsedElement = buildElement(context.dom, {
      tag: "div",
      className: "rad-graph-progress__elapsed",
      attrs: { "aria-label": "Elapsed time" },
      text: elapsedText()
    });
    const head = buildElement(context.dom, {
      tag: "div",
      className: "rad-graph-progress__head",
      children: [
        {
          tag: "div",
          className: "rad-graph-progress__spinner",
          attrs: { "aria-hidden": "true" }
        },
        {
          tag: "div",
          className: "rad-graph-progress__headtext",
          children: [
            {
              tag: "div",
              className: "rad-graph-progress__title",
              text: title
            },
            {
              // Announced politely so a screen reader follows the build without
              // the stage list being re-read on every poll.
              tag: "div",
              className: "rad-graph-progress__activity",
              attrs: { role: "status", "aria-live": "polite" },
              text: latest?.detail ?? ""
            }
          ]
        }
      ]
    });
    head.appendChild(elapsedElement);

    const stageList = buildElement(context.dom, {
      tag: "ol",
      className: "rad-graph-progress__stages",
      children: stages
    });
    const panel = buildElement(context.dom, {
      tag: "div",
      className:
        "rad-graph-progress" + (failed ? " rad-graph-progress--failed" : ""),
      attrs: { role: "region", "aria-label": title }
    });
    panel.appendChild(head);
    panel.appendChild(stageList);
    container.replaceChildren(panel);
  };

  const timer = scope.every(GRAPH_PROGRESS_TICK_MS, () => {
    if (stopped || !elapsedElement) return;
    elapsedElement.textContent = elapsedText();
  });

  const appendEvent = (
    stage: GraphBuildStage,
    state: GraphBuildEventState,
    detail: string
  ): void => {
    const sequence =
      events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
    const event: GraphBuildEvent = { sequence, stage, state, detail };
    events = applyGraphSnapshot(events, [...events, event]);
    latestEvent = event;
    appliedSequence = sequence;
    localAhead = true;
    render();
  };

  const stopView = (): void => {
    if (stopped) return;
    stopped = true;
    scope.cancel(timer);
  };

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
      events = applyGraphSnapshot(events, parsed);
      if (parsed.length > 0) latestEvent = parsed[parsed.length - 1];
      render();
    },
    append(stage, state, detail) {
      if (stopped) return;
      appendEvent(stage, state, detail);
    },
    fail(detail) {
      if (stopped) return;
      // The stage that is still running is the one the failure belongs to. With
      // no such stage the panel has nothing in flight to close out, so only the
      // clock stops.
      const running = events.filter((event) => event.state === "running").pop();
      if (running) appendEvent(running.stage, "failed", detail);
      stopView();
    },
    stop() {
      stopView();
    },
    remount() {
      if (stopped) return;
      // The host element was replaced, so an unchanged panel still has to be
      // drawn again.
      render(true);
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
    latestEvent = options.initial;
    appliedSequence = options.initial.sequence;
    localAhead = true;
  }
  render();

  return view;
}
