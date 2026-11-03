import { describe, expect, it, vi } from "vitest";
import {
  selectGitHubAccount,
  type GitHubAccountSelectionPorts
} from "./github-account-selection.js";

const TARGET = { repo: "fixture/app", environment: "dev" };

function ports(
  overrides: Partial<GitHubAccountSelectionPorts> = {}
): GitHubAccountSelectionPorts {
  return {
    listLogins: async () => ["first", "second"],
    check: async () => ({ state: "eligible" }),
    isCurrent: () => true,
    ...overrides
  };
}

describe("GitHub account selection policy", () => {
  it("pins saved work without discovering or selecting a replacement account", async () => {
    const listLogins = vi.fn(async () => ["second"]);
    const choose = vi.fn(async () => "second");
    const check = vi.fn<GitHubAccountSelectionPorts["check"]>(async () => ({
      state: "ineligible",
      message: "Reauthorize the saved login."
    }));
    expect(
      await selectGitHubAccount(
        { target: TARGET, savedLogin: "first" },
        ports({ listLogins, choose, check })
      )
    ).toEqual({
      state: "reauthorization-required",
      login: "first",
      message: "Reauthorize the saved login."
    });
    expect(listLogins).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledExactlyOnceWith("first", TARGET);
  });

  it("does not treat a missing saved login as new-work permission", async () => {
    const check = vi.fn<GitHubAccountSelectionPorts["check"]>();
    expect(
      await selectGitHubAccount(
        { target: TARGET, savedLogin: "" },
        ports({ check })
      )
    ).toMatchObject({ state: "reauthorization-required" });
    expect(check).not.toHaveBeenCalled();
  });

  it("selects and revalidates the sole eligible identity, not the first or active login", async () => {
    const check = vi.fn<GitHubAccountSelectionPorts["check"]>(async (login) =>
      login === "second" ?
        { state: "eligible" }
      : { state: "ineligible", message: "Missing scope." }
    );
    expect(
      await selectGitHubAccount({ target: TARGET }, ports({ check }))
    ).toEqual({ state: "selected", login: "second" });
    expect(check.mock.calls.map(([login]) => login)).toEqual([
      "first",
      "second",
      "second"
    ]);
  });

  it("deduplicates account names without adding eligibility from duplicate credentials", async () => {
    const check = vi.fn<GitHubAccountSelectionPorts["check"]>(async () => ({
      state: "eligible"
    }));
    expect(
      await selectGitHubAccount(
        { target: TARGET },
        ports({ listLogins: async () => ["First", "first"], check })
      )
    ).toEqual({ state: "selected", login: "First" });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it.each([{ logins: [] }, { logins: ["first"] }])(
    "requires authorization when no login is eligible ($logins)",
    async ({ logins }) => {
      expect(
        await selectGitHubAccount(
          { target: TARGET },
          ports({
            listLogins: async () => logins,
            check: async () => ({
              state: "ineligible",
              message: "Missing access."
            })
          })
        )
      ).toMatchObject({ state: "reauthorization-required" });
    }
  );

  it("does not choose an account when a competing identity's permissions are unknown", async () => {
    const choose = vi.fn(async () => "first");
    expect(
      await selectGitHubAccount(
        { target: TARGET },
        ports({
          check: async (login) =>
            login === "first" ?
              { state: "eligible" }
            : { state: "unavailable", message: "GitHub is unavailable." },
          choose
        })
      )
    ).toEqual({ state: "unavailable", message: "GitHub is unavailable." });
    expect(choose).not.toHaveBeenCalled();
  });

  it("requires an explicit choice when more than one eligible account remains", async () => {
    expect(await selectGitHubAccount({ target: TARGET }, ports())).toEqual({
      state: "choice-required",
      logins: ["first", "second"]
    });
  });

  it.each([
    [null, "declined"],
    ["unlisted", "stale-choice"]
  ] as const)(
    "does not authorize a %j host response",
    async (answer, state) => {
      expect(
        await selectGitHubAccount(
          { target: TARGET },
          ports({ choose: async () => answer })
        )
      ).toEqual({ state });
    }
  );

  it("revalidates a host-held choice against an immutable target", async () => {
    const target = { ...TARGET };
    const check = vi.fn<GitHubAccountSelectionPorts["check"]>(async () => ({
      state: "eligible"
    }));
    const choose: GitHubAccountSelectionPorts["choose"] = async (request) => {
      expect(request.target).toEqual(TARGET);
      expect(Object.isFrozen(request.target)).toBe(true);
      expect(Object.isFrozen(request.logins)).toBe(true);
      target.repo = "fixture/changed";
      return "second";
    };
    expect(
      await selectGitHubAccount({ target }, ports({ check, choose }))
    ).toEqual({ state: "selected", login: "second" });
    expect(check).toHaveBeenLastCalledWith("second", TARGET);
  });

  it("refuses a chosen account that lost access while the host dialog was open", async () => {
    let selected = false;
    expect(
      await selectGitHubAccount(
        { target: TARGET },
        ports({
          check: async () =>
            selected ?
              { state: "ineligible", message: "Access was revoked." }
            : { state: "eligible" },
          choose: async () => {
            selected = true;
            return "first";
          }
        })
      )
    ).toEqual({
      state: "reauthorization-required",
      login: "first",
      message: "Access was revoked."
    });
  });

  it("preserves unavailable evidence when revalidating saved work", async () => {
    expect(
      await selectGitHubAccount(
        { target: TARGET, savedLogin: "saved" },
        ports({
          check: async () => ({ state: "unavailable", message: "Unavailable." })
        })
      )
    ).toEqual({ state: "unavailable", message: "Unavailable." });
  });

  it.each(["before", "list", "eligibility", "choice", "verification"] as const)(
    "refuses continuation if ownership is lost during %s",
    async (boundary) => {
      let current = boundary !== "before";
      let verification = false;
      const check = vi.fn<GitHubAccountSelectionPorts["check"]>(async () => {
        if (
          boundary === "eligibility" ||
          (boundary === "verification" && verification)
        )
          current = false;
        return { state: "eligible" };
      });
      const result = await selectGitHubAccount(
        { target: TARGET },
        ports({
          isCurrent: () => current,
          listLogins: async () => {
            if (boundary === "list") current = false;
            return ["first", "second"];
          },
          check,
          choose: async () => {
            if (boundary === "choice") current = false;
            verification = true;
            return "first";
          }
        })
      );
      expect(result).toEqual({ state: "stopped" });
    }
  );

  it("surfaces discovery and permission failures rather than assuming missing access", async () => {
    const failure = new Error("read failed");
    await expect(
      selectGitHubAccount(
        { target: TARGET },
        ports({
          listLogins: async () => {
            throw failure;
          }
        })
      )
    ).rejects.toBe(failure);
    await expect(
      selectGitHubAccount(
        { target: TARGET },
        ports({
          check: async () => {
            throw failure;
          }
        })
      )
    ).rejects.toBe(failure);
    await expect(
      selectGitHubAccount(
        { target: TARGET },
        ports({
          listLogins: async () => [""]
        })
      )
    ).rejects.toThrow("empty login");
  });
});
