import { describe, expect, it } from "vitest";

import {
  classifyModelReadiness,
  cloudModelingPrompt,
  describeModelReadiness,
  parseSessionInfo,
  parseSessionStatus,
  planModelPublication,
  sessionIdFromAppUrl,
  sessionTitleFromInfoLabel,
  type ModelFileTimes
} from "./copilot-app-modeling.js";

const BASELINE = "cc6a688a0000000000000000000000000000beef";

function times(
  app: number | undefined,
  config: number | undefined,
  origin: number | undefined
): ModelFileTimes {
  return {
    ".radius/app.bicep": app,
    ".radius/bicepconfig.json": config,
    ".radius/app.origin.json": origin
  };
}

describe("cloudModelingPrompt", () => {
  it("asks for a fresh model with the fixed name and no publication", () => {
    const prompt = cloudModelingPrompt("cloud-e2e");
    expect(prompt).toContain("Delete the .radius folder");
    expect(prompt).toContain("radius-app-bicep skill");
    expect(prompt).toContain('Name the Radius application "cloud-e2e".');
    expect(prompt).toContain("Do not commit, push, or deploy.");
  });

  it.each(["", "Cloud", "1app", `a${"b".repeat(63)}`, 'x" and push'])(
    "refuses the name %j",
    (name) => {
      expect(() => cloudModelingPrompt(name)).toThrow(
        /not a valid Radius name/
      );
    }
  );

  it("accepts the longest valid name", () => {
    expect(cloudModelingPrompt(`a${"b".repeat(62)}`)).toContain("abbb");
  });
});

describe("parseSessionInfo", () => {
  it("reads every copy button value", () => {
    expect(
      parseSessionInfo([
        "Close",
        "Copy branch, nicolejms-model",
        " Copy base branch, main ",
        "Copy path, C:\\work\\fixture, with comma",
        "Copy session ID, 3f2a"
      ])
    ).toEqual({
      branch: "nicolejms-model",
      baseBranch: "main",
      path: "C:\\work\\fixture, with comma",
      sessionId: "3f2a"
    });
  });

  it("names the missing fields and the labels it saw", () => {
    expect(() => parseSessionInfo(["Copy branch, x", "Copy path,  "])).toThrow(
      "The session information dialog did not show: base branch, path, session ID. " +
        "Labels seen: Copy branch, x | Copy path,  "
    );
    expect(() => parseSessionInfo([])).toThrow(/Labels seen: <none>/);
  });
});

describe("sessionIdFromAppUrl", () => {
  it.each([
    ["http://tauri.localhost/workspaces/abc", "abc"],
    ["http://tauri.localhost/workspaces/a%20b/", "a b"]
  ])("reads %s", (url, id) => {
    expect(sessionIdFromAppUrl(url)).toBe(id);
  });

  it.each([
    "http://tauri.localhost/",
    "http://tauri.localhost/workspaces/",
    "http://tauri.localhost/workspaces/a/b",
    "not a url"
  ])("ignores %s", (url) => {
    expect(sessionIdFromAppUrl(url)).toBeUndefined();
  });
});

describe("parseSessionStatus", () => {
  it.each([
    ["Model the app. Status: Idle. 2 minutes ago", "Idle"],
    ["Model. Status: Working on it. now", "Working on it"],
    ["Working Model the cloud fixture", "Working"]
  ])("reads %j", (name, status) => {
    expect(parseSessionStatus(name)).toBe(status);
  });

  it.each(["Model the app", "Status: Idle", "Status:  . x", "Workingset"])(
    "returns undefined for %j",
    (name) => {
      expect(parseSessionStatus(name)).toBeUndefined();
    }
  );
});

describe("sessionTitleFromInfoLabel", () => {
  it("reads the title before the branch", () => {
    expect(
      sessionTitleFromInfoLabel(
        "Model the fixture · user-model-branch, session information"
      )
    ).toBe("Model the fixture");
  });

  it.each(["session information", " · branch, session information", "x · y"])(
    "refuses %j",
    (label) => {
      expect(() => sessionTitleFromInfoLabel(label)).toThrow(/has no title/);
    }
  );
});

describe("classifyModelReadiness", () => {
  it("is ready when new files are stable and the session is idle", () => {
    const now = times(200, 201, 202);
    const readiness = classifyModelReadiness({
      times: now,
      startedAtMs: 200,
      previousTimes: now,
      sessionStatus: "Idle"
    });
    expect(readiness).toEqual({
      ready: true,
      missing: [],
      stale: [],
      changing: [],
      sessionStatus: "Idle"
    });
    expect(describeModelReadiness(readiness)).toBe(
      "The model files are ready."
    );
  });

  it("accepts an unknown session status", () => {
    const now = times(300, 300, 300);
    expect(
      classifyModelReadiness({
        times: now,
        startedAtMs: 100,
        previousTimes: now,
        sessionStatus: undefined
      }).ready
    ).toBe(true);
  });

  it("reports missing, stale, changing files, and a busy session", () => {
    const readiness = classifyModelReadiness({
      times: times(undefined, 199, 250),
      startedAtMs: 200,
      previousTimes: times(undefined, 199, 240),
      sessionStatus: "Working"
    });
    expect(readiness).toMatchObject({
      ready: false,
      missing: [".radius/app.bicep"],
      stale: [".radius/bicepconfig.json"],
      changing: [".radius/app.origin.json"]
    });
    expect(describeModelReadiness(readiness)).toBe(
      "The model is not ready (missing: .radius/app.bicep; " +
        "not rewritten yet: .radius/bicepconfig.json; " +
        "still changing: .radius/app.origin.json; session status: Working)."
    );
  });

  it("is not ready on the first poll", () => {
    const readiness = classifyModelReadiness({
      times: times(300, 300, 300),
      startedAtMs: 100,
      previousTimes: undefined,
      sessionStatus: "idle"
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.changing).toHaveLength(3);
  });

  it("is not ready while the session is busy", () => {
    const now = times(300, 300, 300);
    const readiness = classifyModelReadiness({
      times: now,
      startedAtMs: 100,
      previousTimes: now,
      sessionStatus: "Working"
    });
    expect(readiness.ready).toBe(false);
    expect(describeModelReadiness(readiness)).toBe(
      "The model is not ready (session status: Working)."
    );
  });
});

describe("planModelPublication", () => {
  it("commits and pushes staged changes at the baseline", () => {
    expect(
      planModelPublication({
        head: `${BASELINE}\n`,
        baselineSha: BASELINE,
        hasStagedChanges: true
      })
    ).toEqual({ action: "commit-and-push" });
  });

  it("does nothing when the model equals the baseline", () => {
    expect(
      planModelPublication({
        head: BASELINE,
        baselineSha: BASELINE,
        hasStagedChanges: false
      })
    ).toEqual({ action: "unchanged" });
  });

  it.each(["0".repeat(40), ""])(
    "refuses a session branch that moved: %j",
    (head) => {
      expect(() =>
        planModelPublication({
          head,
          baselineSha: BASELINE,
          hasStagedChanges: true
        })
      ).toThrow(/The agent must not commit/);
    }
  );
});
