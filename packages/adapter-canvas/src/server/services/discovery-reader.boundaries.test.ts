import { resolve } from "node:path";
import { expect, it } from "vitest";
import { discoveryControl } from "./discovery-cancellation.js";
import {
  createLegacyDiscoveryReader,
  type LegacyDiscoveryDependencies
} from "./discovery-reader.js";

function fixture(overrides: Partial<LegacyDiscoveryDependencies> = {}) {
  let sequence = 0;
  return createLegacyDiscoveryReader({
    storageRoot: resolve(".test-unused-discovery-reader"),
    identity: async () => ({ actingLogin: "reader" }),
    workspace: async () => {
      throw new Error("No workspace read");
    },
    git: async () => {
      throw new Error("No Git");
    },
    clock: { now: () => "2026-09-15T00:00:00Z" },
    ids: { next: () => `id-${++sequence}` },
    executor: async (login) => ({
      login,
      run: async (args) => {
        const path = args.find((arg) => arg.startsWith("/repos/"));
        if (path === "/repos/owner/repo")
          return {
            code: 0,
            stdout: JSON.stringify({ full_name: "owner/repo" }),
            stderr: ""
          };
        if (path?.includes("/environments?"))
          return {
            code: 0,
            stdout: JSON.stringify({ environments: [] }),
            stderr: ""
          };
        return { code: 1, stdout: "", stderr: "HTTP 403" };
      }
    }),
    ...overrides
  });
}
it("catches cancellation during identity resolution and releases the late subscription", async () => {
  let aborted = false;
  let disposals = 0;
  const result = await fixture({
    identity: async () => {
      aborted = true;
      return { actingLogin: "reader" };
    }
  }).open("owner/repo", "panel", {
    get aborted() {
      return aborted;
    },
    onAbort(listener) {
      if (aborted) listener();
      return () => {
        disposals++;
      };
    }
  });
  expect(result.status).toBe("cancelled");
  expect(disposals).toBe(1);
});

it("releases request subscriptions when trusted identifier allocation fails", async () => {
  let ids = 0;
  let disposals = 0;
  const result = await fixture({
    ids: {
      next: () => {
        if (++ids === 2) throw new Error("Private identifier failure");
        return "binding";
      }
    }
  }).open("owner/repo", "panel", {
    aborted: false,
    onAbort: () => () => {
      disposals++;
    }
  });
  expect(result.status).toBe("unavailable");
  expect(disposals).toBe(1);
  expect(JSON.stringify(result)).not.toContain("Private identifier failure");
});

it("rechecks the reader between caller resolution and source authorization", async () => {
  let identityReads = 0;
  const opened = await fixture({
    identity: async () => ({
      actingLogin: ++identityReads <= 3 ? "reader" : "other"
    })
  }).open("owner/repo", "panel");
  if (opened.status !== "ok") throw new Error("Expected reader");
  try {
    expect(await opened.value.applications("feature")).toMatchObject({
      status: "forbidden"
    });
    expect(identityReads).toBe(4);
  } finally {
    await opened.value.close();
  }
});

it.each(["wrong-executor", "command-failed", "command-error"] as const)(
  "fences auxiliary observations after %s",
  async (kind) => {
    let openedOnce = false;
    const opened = await fixture({
      executor: async (login) => ({
        login: openedOnce && kind === "wrong-executor" ? "other" : login,
        run: async () => {
          if (!openedOnce)
            return {
              code: 0,
              stdout: '{"full_name":"owner/repo"}',
              stderr: ""
            };
          if (kind === "command-error")
            throw new Error("Private command detail");
          return {
            code: 1,
            stdout: "Partial untrusted output",
            stderr: "Private command detail"
          };
        }
      })
    }).open("owner/repo", "panel");
    if (opened.status !== "ok") throw new Error("Expected reader");
    openedOnce = true;
    try {
      expect(
        await opened.value.run([
          "api",
          "/repos/owner/repo/deployments",
          "--jq",
          "."
        ])
      ).toEqual({ ok: false, stdout: "" });
    } finally {
      await opened.value.close();
    }
  }
);

it.each(["absent", "cancelled", "paginated", "bounded"] as const)(
  "retains %s canonical environment inspection outcomes",
  async (kind) => {
    const abort = new AbortController();
    const names = Array.from(
      {
        length:
          kind === "bounded" ? 1000
          : kind === "paginated" ? 51
          : 2
      },
      (_, index) => `env-${String(index).padStart(2, "0")}`
    );
    const opened = await fixture({
      executor: async (login) => ({
        login,
        run: async (args) => {
          const path = args.find((arg) => arg.startsWith("/repos/"));
          let value: unknown;
          if (path === "/repos/owner/repo") value = { full_name: "owner/repo" };
          else if (path?.includes("/environments?")) {
            const page = Number(
              new URL(path, "https://github.invalid").searchParams.get("page")
            );
            value = {
              environments: names
                .slice((page - 1) * 100, page * 100)
                .map((name) => ({ name }))
            };
          } else if (kind === "absent")
            return { code: 1, stdout: "", stderr: "HTTP 404" };
          else if (kind === "cancelled") {
            abort.abort();
            value = {};
          } else if (path?.includes("/variables")) value = { variables: [] };
          else if (path?.includes("/environments/env-"))
            value = {
              name: path.split("/").pop(),
              id: 1,
              protection_rules: []
            };
          else throw new Error("Unmodeled environment command");
          return { code: 0, stdout: JSON.stringify(value), stderr: "" };
        }
      })
    }).open(
      "owner/repo",
      "panel",
      discoveryControl("http", abort.signal).cancellation
    );
    if (opened.status !== "ok") throw new Error("Expected reader");
    try {
      const result = await opened.value.environments();
      if (kind === "cancelled") expect(result.status).toBe("cancelled");
      else if (kind === "absent")
        expect(result).toMatchObject({
          status: "ok",
          value: { entries: [], error: { code: "RESULT_UNAVAILABLE" } }
        });
      else {
        if (result.status !== "ok")
          throw new Error("Expected complete page traversal");
        expect(
          result.value.entries.map(
            (entry) => entry.inspection.target.environment
          )
        ).toEqual(names);
        if (kind === "bounded")
          expect(result.value.error).toMatchObject({
            code: "RESULT_UNAVAILABLE"
          });
        else expect(result.value.error).toBeUndefined();
      }
    } finally {
      await opened.value.close();
    }
  }
);

it("requires complete construction and rejects invalid or cancelled requests before identity IO", async () => {
  expect(() =>
    Reflect.apply(createLegacyDiscoveryReader, undefined, [{}])
  ).toThrow("requires");
  const reader = fixture({
    identity: async () => {
      throw new Error("Must not read identity");
    }
  });
  expect(await reader.open("../escape", "panel")).toMatchObject({
    error: { code: "INVALID_REQUEST" }
  });
  expect(
    await reader.open("owner/repo", "panel", {
      aborted: true,
      onAbort: () => () => {}
    })
  ).toMatchObject({ status: "cancelled" });
});
it.each([
  "missing-identity",
  "identity-error",
  "wrong-repository",
  "malformed",
  "executor-error"
] as const)(
  "keeps %s prerequisites explicit and releases request listeners",
  async (kind) => {
    let subscriptions = 0;
    let disposals = 0;
    const reader = fixture({
      identity: async () => {
        if (kind === "identity-error")
          throw new Error("Private upstream detail");
        return { actingLogin: kind === "missing-identity" ? "" : "reader" };
      },
      executor: async (login) => {
        if (kind === "executor-error")
          throw new Error("Private upstream detail");
        return {
          login,
          run: async () => ({
            code: 0,
            stderr: "",
            stdout:
              kind === "malformed" ? "{}" : (
                JSON.stringify({ full_name: "other/repo" })
              )
          })
        };
      }
    });
    const result = await reader.open("owner/repo", "panel", {
      aborted: false,
      onAbort: () => {
        subscriptions++;
        return () => {
          disposals++;
        };
      }
    });
    expect(result.status).not.toBe("ok");
    expect(JSON.stringify(result)).not.toContain("Private upstream detail");
    expect(disposals).toBe(subscriptions);
  }
);
it("never lets auxiliary legacy reads perform mutations or cross repository boundaries", async () => {
  const opened = await fixture().open("owner/repo", "panel");
  if (opened.status !== "ok") throw new Error("Expected reader");
  try {
    for (const args of [
      ["api", "/repos/owner/repo/deployments", "--method=POST", "{}"],
      ["api", "/repos/other/repo/deployments", "--jq", "."],
      ["api", "/repos/owner/repo/../../other", "--jq", "."]
    ])
      expect(await opened.value.run(args)).toEqual({ ok: false, stdout: "" });
    expect(await opened.value.applications("feature")).toMatchObject({
      status: "forbidden"
    });
    expect(await opened.value.environments()).toEqual({
      status: "ok",
      value: { entries: [] }
    });
    await opened.value.close();
    expect(await opened.value.applications("feature")).toMatchObject({
      status: "cancelled"
    });
    expect(await opened.value.environments()).toMatchObject({
      status: "cancelled"
    });
    expect(
      await opened.value.run([
        "api",
        "/repos/owner/repo/deployments",
        "--jq",
        "."
      ])
    ).toEqual({ ok: false, stdout: "" });
  } finally {
    await opened.value.close();
  }
});
it("refuses observations after the acting reader changes", async () => {
  let login = "reader";
  const opened = await fixture({
    identity: async () => ({ actingLogin: login })
  }).open("owner/repo", "panel");
  if (opened.status !== "ok") throw new Error("Expected reader");
  try {
    login = "other";
    expect(await opened.value.environments()).toMatchObject({
      status: "forbidden"
    });
    expect(await opened.value.applications("feature")).toMatchObject({
      status: "forbidden"
    });
  } finally {
    await opened.value.close();
  }
});
