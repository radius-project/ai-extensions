import { describe, expect, it } from "vitest";
import { githubCredentialSourceLabel } from "./github-credential-source.js";

describe("GitHub credential source label", () => {
  it.each(["injected", "injected-token"])(
    "labels %s as the Copilot session token",
    (source) => {
      expect(githubCredentialSourceLabel(source)).toBe(
        "the Copilot session token"
      );
    }
  );

  it.each(["keyring", "", "unavailable"])(
    "labels %s as the stored GitHub CLI credential",
    (source) => {
      expect(githubCredentialSourceLabel(source)).toBe(
        "the stored GitHub CLI credential"
      );
    }
  );
});
