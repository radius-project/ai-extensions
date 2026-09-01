import { describe, expect, it } from "vitest";
import {
  DELETE_CONFLICT_PATH,
  DELETE_FAILED_STATUS,
  FORCE_DELETE_ORPHAN_NOTICE,
  FORCE_DELETE_ORPHAN_WARNING,
  deleteConflictUrl,
  forceDeletePrompt,
  parseDeleteConflict,
  probeDeleteConflict
} from "./force-delete.js";
import {
  createFakeBrowser,
  jsonResponse
} from "../../test/support/browser/fakes.js";

const TARGET = {
  repo: "octo/todo",
  environment: "dev",
  application: "todo-app"
};

const CONFLICT_URL = deleteConflictUrl(TARGET);

const NO_CONFLICT = {
  conflict: false,
  resourceState: "",
  forced: false,
  detail: ""
};

describe("force delete conflict probe", () => {
  it("names the status a failed delete carries and the caution a forced one earns", () => {
    expect(DELETE_FAILED_STATUS).toBe("delete-failed");
    expect(FORCE_DELETE_ORPHAN_NOTICE).toContain("orphaned external resources");
    expect(FORCE_DELETE_ORPHAN_NOTICE).toContain("manual cleanup");
  });

  it("encodes every identity segment into the probe URL", () => {
    expect(
      deleteConflictUrl({
        repo: "octo/to do",
        environment: "dev&prod",
        application: "a=b"
      })
    ).toBe(
      `${DELETE_CONFLICT_PATH}?repo=octo%2Fto%20do&environment=dev%26prod&application=a%3Db`
    );
  });

  describe("parsing the answer", () => {
    it("reads a proven conflict with the state that caused it", () => {
      expect(
        parseDeleteConflict({
          conflict: true,
          resourceState: "Updating",
          forced: true,
          detail: ""
        })
      ).toEqual({
        conflict: true,
        resourceState: "Updating",
        forced: true,
        detail: ""
      });
    });

    it("keeps the reason when the server reports no conflict", () => {
      expect(
        parseDeleteConflict({ conflict: false, detail: "artifact expired." })
      ).toEqual({ ...NO_CONFLICT, detail: "artifact expired." });
    });

    // The state is the evidence, so a conflict asserted without one is not
    // enough to unlock the destructive path.
    it("refuses a conflict that does not name a resource state", () => {
      expect(parseDeleteConflict({ conflict: true, detail: "why" })).toEqual({
        ...NO_CONFLICT,
        detail: "why"
      });
    });

    it.each([
      ["a non-object", "conflict"],
      ["null", null],
      ["an array", []],
      ["undefined", undefined]
    ])("reports no conflict for %s payload", (_case, payload) => {
      expect(parseDeleteConflict(payload)).toEqual(NO_CONFLICT);
    });

    it("ignores fields of the wrong type", () => {
      expect(
        parseDeleteConflict({
          conflict: "true",
          resourceState: 7,
          forced: "yes",
          detail: 3
        })
      ).toEqual(NO_CONFLICT);
    });
  });

  describe("asking the server", () => {
    it("reports the conflict the server proved", async () => {
      const browser = createFakeBrowser();
      browser.net.handle(CONFLICT_URL, () =>
        jsonResponse({
          conflict: true,
          resourceState: "Updating",
          forced: false,
          detail: ""
        })
      );

      await expect(
        probeDeleteConflict(browser.context, TARGET)
      ).resolves.toEqual({
        conflict: true,
        resourceState: "Updating",
        forced: false,
        detail: ""
      });
      expect(browser.net.calls.map((call) => call.url)).toEqual([CONFLICT_URL]);
    });

    it("reports no conflict when the probe is refused", async () => {
      const browser = createFakeBrowser();
      browser.net.handle(CONFLICT_URL, () =>
        jsonResponse({ error: "bad request" }, false, 400)
      );

      await expect(
        probeDeleteConflict(browser.context, TARGET)
      ).resolves.toEqual(NO_CONFLICT);
    });

    // A delete click must never fail because the optional probe did.
    it("reports no conflict when the request itself fails", async () => {
      const browser = createFakeBrowser();

      await expect(
        probeDeleteConflict(browser.context, TARGET)
      ).resolves.toEqual(NO_CONFLICT);
      expect(browser.net.calls).toHaveLength(1);
    });

    it.each([
      ["repo", { ...TARGET, repo: "" }],
      ["environment", { ...TARGET, environment: "" }],
      ["application", { ...TARGET, application: "" }]
    ])("does not ask at all without a %s", async (_case, request) => {
      const browser = createFakeBrowser();

      await expect(
        probeDeleteConflict(browser.context, request)
      ).resolves.toEqual(NO_CONFLICT);
      expect(browser.net.calls).toEqual([]);
    });
  });
});

describe("forceDeletePrompt", () => {
  it("names the resource state the server proved", () => {
    const prompt = forceDeletePrompt("todo-app", "dev", "Updating");

    expect(prompt.title).toBe("Force delete this deployment?");
    expect(prompt.message).toContain('"todo-app"');
    expect(prompt.message).toContain('"dev"');
    expect(prompt.message).toContain('still in the "Updating" state');
    expect(prompt.usageLabel).toBe(FORCE_DELETE_ORPHAN_WARNING);
    expect(prompt.confirmLabel).toBe("Force delete");
    expect(prompt.cancelLabel).toBe("Cancel");
  });

  it("opts the standalone caution into a block with no list", () => {
    expect(forceDeletePrompt("todo-app", "dev", "Updating")).toMatchObject({
      showUsageWithoutItems: true
    });
  });

  // Forcing again is still the only escape, so it stays offered — with the
  // warning that the provider may need a manual cleanup either way.
  it("warns when the delete it escalates was itself already forced", () => {
    const repeated = forceDeletePrompt("todo-app", "dev", "Updating", true);
    const first = forceDeletePrompt("todo-app", "dev", "Updating", false);

    expect(repeated.message).toContain("previous delete was already forced");
    expect(repeated.message).toContain("leftover resources");
    expect(repeated.confirmLabel).toBe("Force delete");
    expect(first.message).not.toContain("already forced");
  });

  it("falls back to a generic state when the server named none", () => {
    const prompt = forceDeletePrompt("todo-app", "dev", "");

    expect(prompt.message).toContain("still in a non-terminal state");
    expect(prompt.message).not.toContain('""');
  });
});
