import { describe, it, expect } from "vitest";
import { DEPLOYING_CLIENT_JS } from "./client-deployments.js";

describe("DEPLOYING_CLIENT_JS", () => {
  it("parses as browser JavaScript", () => {
    expect(DEPLOYING_CLIENT_JS.length).toBeGreaterThan(0);
    expect(() => new Function(DEPLOYING_CLIENT_JS)).not.toThrow();
  });

  it("declares the deployment behaviour the page wires up", () => {
    for (const declaration of [
      "escapeHtmlClient",
      "opKey",
      "refreshDeployBtn",
      "loadApplications",
      "loadEnvironmentsDropdown",
      "loadBranches",
      "loadDeployments",
      "runDelete",
      "showDeployFailed",
      "resumeRedirectedDeployment"
    ]) {
      expect(DEPLOYING_CLIENT_JS).toContain(`function ${declaration}(`);
    }
  });

  it("runs its initial load last so every helper is already declared", () => {
    expect(
      DEPLOYING_CLIENT_JS.trimEnd().endsWith(
        "if (!resumeRedirectedDeployment()) loadDeployments();"
      )
    ).toBe(true);
  });

  it("is a plain script fragment with no unresolved interpolation or early tag closure", () => {
    expect(DEPLOYING_CLIENT_JS).not.toContain("${");
    expect(DEPLOYING_CLIENT_JS).not.toContain("</script>");
    expect(DEPLOYING_CLIENT_JS.trim().length).toBeGreaterThan(0);
  });
});
