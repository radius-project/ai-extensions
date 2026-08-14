import { describe, it, expect } from "vitest";
import { ENVIRONMENT_TABLE_CLIENT_JS } from "./client-environments.js";
import { ENVIRONMENT_OPERATION_CLIENT_JS } from "./client-operations.js";
import { ENVIRONMENT_PROFILE_CLIENT_JS } from "./client-profiles.js";
import { ENVIRONMENT_DISCOVERY_CLIENT_JS } from "./client-discovery.js";
import { ENVIRONMENT_CREDENTIAL_CLIENT_JS } from "./client-credentials.js";

const fragments: Array<[string, string, string[]]> = [
  [
    "client-environments",
    ENVIRONMENT_TABLE_CLIENT_JS,
    ["switchSubtab", "loadEnvTable", "wireRowActions", "showEnvForm"]
  ],
  [
    "client-operations",
    ENVIRONMENT_OPERATION_CLIENT_JS,
    [
      "formatElapsed",
      "renderEnvProgress",
      "trackEnvProgress",
      "resumeEnvProgress",
      "applyEnvTerminal"
    ]
  ],
  [
    "client-profiles",
    ENVIRONMENT_PROFILE_CLIENT_JS,
    [
      "findProfile",
      "renderProfileOptions",
      "loadProfilesIntoEnvSelect",
      "renderGitHubIdentity"
    ]
  ],
  [
    "client-discovery",
    ENVIRONMENT_DISCOVERY_CLIENT_JS,
    [
      "clearSharedAppPin",
      "discoverResources",
      "findAzureClusterResourceGroup",
      "showAppPicker"
    ]
  ],
  [
    "client-credentials",
    ENVIRONMENT_CREDENTIAL_CLIENT_JS,
    ["loadCredTable", "showCredForm", "markVerified", "credVerifyError"]
  ]
];

describe("environment page client fragments", () => {
  it.each(fragments)("%s parses as browser JavaScript", (_name, source) => {
    expect(source.length).toBeGreaterThan(0);
    expect(() => new Function(source)).not.toThrow();
  });

  it.each(fragments)(
    "%s declares the behaviour it owns",
    (_name, source, declarations) => {
      for (const declaration of declarations) {
        expect(source).toContain(`function ${declaration}(`);
      }
    }
  );

  it("splits the client script into disjoint fragments", () => {
    for (const [name, , declarations] of fragments) {
      for (const [otherName, otherSource] of fragments) {
        if (otherName === name) continue;
        for (const declaration of declarations) {
          expect(
            otherSource.includes(`function ${declaration}(`),
            `${otherName} redeclares ${declaration} owned by ${name}`
          ).toBe(false);
        }
      }
    }
  });

  it("keeps each fragment a plain script that cannot close the page's script block", () => {
    for (const [name, source] of fragments) {
      // The fragments are concatenated inside one <script> block, so a literal
      // closing tag anywhere in them would end the page's script early.
      expect(source.includes("</script>"), name).toBe(false);
      expect(source.trim().length).toBeGreaterThan(0);
    }
  });

  it("carries interpolation only where a tested helper is serialized into the script", () => {
    for (const [name, source] of fragments) {
      const interpolations = source.split("${").length - 1;
      if (name === "client-discovery") {
        // The serialized azure-oidc helpers are real JavaScript source, so they
        // legitimately carry template literals of their own.
        expect(interpolations).toBeGreaterThan(0);
        expect(source).toContain("var formatServesReposLabel = function");
      } else {
        expect(interpolations, name).toBe(0);
      }
    }
  });

  it("serializes the tested azure-oidc helpers under their stable browser names", () => {
    expect(ENVIRONMENT_DISCOVERY_CLIENT_JS).toContain(
      "var formatServesReposLabel = function"
    );
    expect(ENVIRONMENT_DISCOVERY_CLIENT_JS).toContain(
      "var discoverStatusText = function"
    );
    expect(ENVIRONMENT_DISCOVERY_CLIENT_JS).not.toContain(
      "formatServesReposLabelClient"
    );
  });
});
