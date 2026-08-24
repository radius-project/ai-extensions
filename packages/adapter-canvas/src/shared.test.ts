// Tests for credential-profile persistence (Environments → Credentials tab) and
// for the instance-scoped graph build record.
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  listCredentialProfiles,
  saveCredentialProfile,
  deleteCredentialProfile,
  expireGraphProgressWait,
  recordGraphBuildEvent,
  resolveCredentialsFilePath,
  sharedCredentials
} from "./shared.js";
import type { GraphBuildEvent, GraphProgressRecord } from "./shared.js";

const REPO = "octo-test/creds-" + Math.random().toString(36).slice(2);

describe("credential store path", () => {
  it("uses the configured isolated path when one is supplied", () => {
    expect(
      resolveCredentialsFilePath(
        { RADIUS_CREDENTIALS_FILE: "  fixture/credentials.json  " },
        "package"
      )
    ).toBe("fixture/credentials.json");
  });

  it("falls back to the package-local compatibility path", () => {
    expect(resolveCredentialsFilePath({}, "package")).toBe(
      path.join("package", ".radius-credentials.json")
    );
  });
});

describe("credential profiles", () => {
  beforeEach(() => {
    for (const p of listCredentialProfiles(REPO))
      deleteCredentialProfile(REPO, p.name);
  });

  it("returns an empty list for an unknown repo", () => {
    delete sharedCredentials.profiles;
    expect(listCredentialProfiles(REPO)).toEqual([]);
  });

  it("saves an azure profile with normalized fields and 'verified' status", () => {
    const saved = saveCredentialProfile(REPO, {
      name: "azure-staging",
      provider: "azure",
      user: "u@d.com",
      tenantId: "t1",
      subscriptionId: "s1"
    });
    expect(saved).toMatchObject({
      name: "azure-staging",
      provider: "azure",
      status: "verified",
      user: "u@d.com"
    });
    const list = listCredentialProfiles(REPO);
    expect(list).toHaveLength(1);
    expect(list[0].tenantId).toBe("t1");
  });

  it("persists the friendly subscription/tenant display names for the env picker", () => {
    const saved = saveCredentialProfile(REPO, {
      name: "azure-prod",
      provider: "azure",
      user: "u@d.com",
      tenantId: "t1",
      tenantName: "Contoso",
      subscriptionId: "s1",
      subscriptionName: "Radius Test"
    });
    expect(saved?.subscriptionName).toBe("Radius Test");
    expect(saved?.tenantName).toBe("Contoso");
    // Older profiles saved without the display names round-trip as empty strings.
    const bare = saveCredentialProfile(REPO, {
      name: "azure-bare",
      provider: "azure",
      subscriptionId: "s2"
    });
    expect(bare?.subscriptionName).toBe("");
    expect(bare?.tenantName).toBe("");
  });

  it("upserts by name (case-insensitive) instead of duplicating", () => {
    saveCredentialProfile(REPO, {
      name: "prod",
      provider: "azure",
      subscriptionId: "s1"
    });
    saveCredentialProfile(REPO, {
      name: "PROD",
      provider: "azure",
      subscriptionId: "s2"
    });
    const list = listCredentialProfiles(REPO);
    expect(list).toHaveLength(1);
    expect(list[0].subscriptionId).toBe("s2");
  });

  it("defaults an unknown provider to azure and keeps aws when given", () => {
    expect(
      saveCredentialProfile(REPO, { name: "a", provider: "gcp" })?.provider
    ).toBe("azure");
    expect(
      saveCredentialProfile(REPO, {
        name: "b",
        provider: "aws",
        accountId: "123"
      })?.provider
    ).toBe("aws");
  });

  it("deletes a profile by name", () => {
    saveCredentialProfile(REPO, { name: "gone", provider: "aws" });
    expect(deleteCredentialProfile(REPO, "gone")).toBe(true);
    expect(listCredentialProfiles(REPO)).toEqual([]);
  });
});
describe("graph build record", () => {
  interface EventStore {
    graphBuildEvents?: GraphBuildEvent[];
  }

  function stages(state: EventStore): string[] {
    return (state.graphBuildEvents ?? []).map(
      (event) => `${event.sequence}:${event.stage}:${event.state}`
    );
  }

  it("retains a terminal app-model wait verdict for an in-flight retry", () => {
    const record: GraphProgressRecord = {
      graphBuildEvents: [],
      graphProgressGeneration: 1,
      graphProgressStartedAtMs: 1_000,
      graphProgressActive: true,
      graphProgressView: "graph",
      graphProgressKey: "octo/app@main",
      graphProgressOwner: 1,
      graphProgressAwaitingModel: true,
      graphProgressWaitStartedAtMs: 1_000,
      graphProgressLastActivityAtMs: 2_000
    };

    expireGraphProgressWait(record, "The modeling wait expired.");

    expect(record).toMatchObject({
      graphProgressActive: false,
      graphProgressAwaitingModel: false,
      graphProgressWaitExpiredMessage: "The modeling wait expired."
    });
    expect(record.graphProgressWaitStartedAtMs).toBeUndefined();
    expect(record.graphProgressLastActivityAtMs).toBeUndefined();
    expect(record.graphBuildEvents.at(-1)).toMatchObject({
      stage: "creating_model",
      state: "failed",
      detail: "The modeling wait expired."
    });
  });

  it("starts a record on the first event and numbers events in order", () => {
    const state: EventStore = {};
    recordGraphBuildEvent(state, {
      stage: "checking_model",
      state: "running",
      detail: "Checking for an application model."
    });
    recordGraphBuildEvent(state, {
      stage: "checking_model",
      state: "succeeded",
      detail: ""
    });
    expect(stages(state)).toEqual([
      "1:checking_model:running",
      "2:checking_model:succeeded"
    ]);
  });

  // The app.bicep wait re-issues its request every few seconds and each attempt
  // re-reports the stages it already completed. Recording those would walk the
  // panel backwards, which reads as a stuck build rather than a wait.
  it("drops a running event for a stage that already settled", () => {
    const state: EventStore = {};
    recordGraphBuildEvent(state, {
      stage: "checking_model",
      state: "running",
      detail: ""
    });
    recordGraphBuildEvent(state, {
      stage: "checking_model",
      state: "succeeded",
      detail: ""
    });
    recordGraphBuildEvent(state, {
      stage: "checking_model",
      state: "running",
      detail: "Checking again."
    });
    expect(stages(state)).toEqual([
      "1:checking_model:running",
      "2:checking_model:succeeded"
    ]);
  });

  // A stage that settled can still fail later: a compile that succeeded and a
  // deploy that then rejected its output is a real sequence, and suppressing the
  // failure would leave the panel claiming success.
  it("records a settled stage failing after the fact", () => {
    const state: EventStore = {};
    recordGraphBuildEvent(state, {
      stage: "building_graph",
      state: "succeeded",
      detail: ""
    });
    recordGraphBuildEvent(state, {
      stage: "building_graph",
      state: "failed",
      detail: "The model was rejected."
    });
    expect(stages(state)).toEqual([
      "1:building_graph:succeeded",
      "2:building_graph:failed"
    ]);
  });

  it("keeps recording a stage that is still running", () => {
    const state: EventStore = {};
    recordGraphBuildEvent(state, {
      stage: "building_graph",
      state: "running",
      detail: "first"
    });
    recordGraphBuildEvent(state, {
      stage: "building_graph",
      state: "running",
      detail: "second"
    });
    expect(stages(state)).toEqual([
      "1:building_graph:running",
      "2:building_graph:running"
    ]);
  });

  // Every poll of an in-flight app.bicep wait replays the whole stage list.
  // Appending those replays would grow a duplicate tail on the checklist once
  // per poll, so an event that repeats a stage's latest one verbatim is dropped.
  it("drops an event that repeats a stage verbatim", () => {
    const state: EventStore = {};
    for (let attempt = 0; attempt < 3; attempt += 1) {
      recordGraphBuildEvent(state, {
        stage: "checking_model",
        state: "succeeded",
        detail: "Found the application model."
      });
      recordGraphBuildEvent(state, {
        stage: "creating_model",
        state: "running",
        detail: "Copilot is authoring the model."
      });
    }
    expect(stages(state)).toEqual([
      "1:checking_model:succeeded",
      "2:creating_model:running"
    ]);
  });

  it("records a repeat that carries new detail", () => {
    const state: EventStore = {};
    recordGraphBuildEvent(state, {
      stage: "creating_model",
      state: "running",
      detail: "Waiting."
    });
    recordGraphBuildEvent(state, {
      stage: "creating_model",
      state: "running",
      detail: "Still waiting."
    });
    expect(stages(state)).toEqual([
      "1:creating_model:running",
      "2:creating_model:running"
    ]);
  });

  // The verbatim rule keys on the stage's own latest event, not the record's,
  // so two stages narrating in turn do not suppress each other.
  it("compares against the stage's own latest event", () => {
    const state: EventStore = {};
    recordGraphBuildEvent(state, {
      stage: "checking_model",
      state: "running",
      detail: "same"
    });
    recordGraphBuildEvent(state, {
      stage: "building_graph",
      state: "running",
      detail: "same"
    });
    recordGraphBuildEvent(state, {
      stage: "checking_model",
      state: "running",
      detail: "same"
    });
    expect(stages(state)).toEqual([
      "1:checking_model:running",
      "2:building_graph:running"
    ]);
  });

  it("does not let one stage settling suppress another", () => {
    const state: EventStore = {};
    recordGraphBuildEvent(state, {
      stage: "checking_model",
      state: "succeeded",
      detail: ""
    });
    recordGraphBuildEvent(state, {
      stage: "building_graph",
      state: "running",
      detail: ""
    });
    expect(stages(state)).toEqual([
      "1:checking_model:succeeded",
      "2:building_graph:running"
    ]);
  });

  it("appends to a record that already carries events", () => {
    const state: EventStore = {
      graphBuildEvents: [
        { sequence: 1, stage: "checking_model", state: "running", detail: "" }
      ]
    };
    recordGraphBuildEvent(state, {
      stage: "building_graph",
      state: "running",
      detail: ""
    });
    expect(stages(state)).toEqual([
      "1:checking_model:running",
      "2:building_graph:running"
    ]);
  });
});
