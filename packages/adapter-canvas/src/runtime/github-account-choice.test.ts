import { describe, expect, it, vi } from "vitest";
import { githubAccountChoice } from "./github-account-choice.js";

describe("host-held GitHub account choice", () => {
  it.each([
    undefined,
    {},
    { capabilities: {} },
    { capabilities: { ui: {} } },
    { capabilities: { ui: { elicitation: false } } },
    { capabilities: { ui: { elicitation: true } } }
  ])(
    "explicitly leaves selection unavailable without a capable host (%j)",
    (session) => {
      expect(githubAccountChoice(session)).toBeUndefined();
    }
  );

  it.each(["chosen", null])(
    "returns the host response %j without inventing approval",
    async (answer) => {
      const select = vi.fn(async () => answer);
      const choose = githubAccountChoice({
        capabilities: { ui: { elicitation: true } },
        ui: { select }
      });
      if (!choose) throw new Error("Expected supported selection");
      expect(
        await choose({
          target: { repo: "fixture/app", environment: "dev" },
          logins: Object.freeze(["first", "chosen"])
        })
      ).toBe(answer);
      expect(select).toHaveBeenCalledExactlyOnceWith(
        "Choose the GitHub account for fixture/app, environment dev. Radius will recheck its access before starting work.",
        ["first", "chosen"]
      );
    }
  );

  it("does not access the capability-gated UI getter on an unsupported host", () => {
    const ui = vi.fn(() => {
      throw new Error("Unsupported host UI");
    });
    expect(
      githubAccountChoice({
        get ui() {
          return ui();
        }
      })
    ).toBeUndefined();
    expect(ui).not.toHaveBeenCalled();
  });
});
