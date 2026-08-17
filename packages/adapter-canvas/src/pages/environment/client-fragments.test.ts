import { describe, it, expect } from "vitest";
import { environmentPage } from "../environment-page.js";
import { ENVIRONMENT_CONFIRM_CLIENT_JS } from "./client-confirm.js";
import { ENVIRONMENT_TABLE_CLIENT_JS } from "./client-environments.js";
import { ENVIRONMENT_OPERATION_CLIENT_JS } from "./client-operations.js";
import { ENVIRONMENT_PROFILE_CLIENT_JS } from "./client-profiles.js";
import { ENVIRONMENT_DISCOVERY_CLIENT_JS } from "./client-discovery.js";
import { ENVIRONMENT_WIZARD_CLIENT_JS } from "./client-wizard.js";
import { ENVIRONMENT_CREDENTIAL_CLIENT_JS } from "./client-credentials.js";

// Isolates the click handler bound to one element id so a wiring assertion
// cannot accidentally match an identical call somewhere else in the fragment.
function handlerFor(source: string, elementId: string): string {
  const start = source.indexOf(
    `document.getElementById('${elementId}').addEventListener('click'`
  );
  if (start < 0) throw new Error(`no click handler bound to #${elementId}`);
  const end = source.indexOf("\n});", start);
  if (end < 0) throw new Error(`unterminated handler for #${elementId}`);
  return source.slice(start, end);
}

const fragments: Array<[string, string, string[]]> = [
  [
    "client-confirm",
    ENVIRONMENT_CONFIRM_CLIENT_JS,
    ["showConfirmDialog", "closeConfirmDialog"]
  ],
  [
    "client-environments",
    ENVIRONMENT_TABLE_CLIENT_JS,
    [
      "switchSubtab",
      "loadEnvTable",
      "wireRowActions",
      "showEnvForm",
      "deleteEnvironment"
    ]
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
    "client-wizard",
    ENVIRONMENT_WIZARD_CLIENT_JS,
    [
      "moveCredFormTo",
      "showEnvWizardStep",
      "updateEnvStep1State",
      "renderEnvProfileSummary",
      "startCredentialCreation",
      "endCredentialCreation",
      "showStandaloneCredForm"
    ]
  ],
  [
    "client-credentials",
    ENVIRONMENT_CREDENTIAL_CLIENT_JS,
    [
      "loadCredTable",
      "showCredForm",
      "markVerified",
      "credVerifyError",
      "credentialUsage",
      "deleteCredentialProfile"
    ]
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

  // The browser layer that could click these buttons is not delivered yet, so
  // these guard the wiring contract only: which entry point each creation
  // affordance is bound to. They cannot prove the resulting behaviour.
  it("keeps the Credentials sub-tab's create action out of the environment wizard", () => {
    const handler = handlerFor(
      ENVIRONMENT_CREDENTIAL_CLIENT_JS,
      "new-cred-btn"
    );
    expect(handler).toContain("showStandaloneCredForm()");
    expect(handler).not.toContain("startCredentialCreation");
    expect(handler).not.toContain("showEnvForm");
    expect(handler).not.toContain("switchSubtab");
  });

  it("enters the wizard's credential step only from the environment flow", () => {
    expect(ENVIRONMENT_DISCOVERY_CLIENT_JS).toContain(
      "startCredentialCreation()"
    );
    expect(ENVIRONMENT_CREDENTIAL_CLIENT_JS).not.toContain(
      "startCredentialCreation("
    );
  });

  it("returns a standalone save to the credentials listing, not to step 2", () => {
    const handler = handlerFor(
      ENVIRONMENT_CREDENTIAL_CLIENT_JS,
      "save-cred-btn"
    );
    expect(handler).toContain("var wizard = CRED_FORM_CONTEXT === 'wizard'");
    expect(handler).toContain("showCredLanding(); showCredSuccessBanner(name)");
    expect(handler).toContain("showEnvWizardStep(2)");
  });

  it("offers no way to edit a stored profile", () => {
    // Profiles are create-and-delete only: an edit would have to re-verify
    // every field anyway, and renaming was the only way a profile's name could
    // drift from the one recorded on environments created from it.
    for (const [name, source] of fragments) {
      expect(source.includes("js-cred-edit"), name).toBe(false);
      expect(source.includes("originalName"), name).toBe(false);
      expect(source.includes("Edit Credential Profile"), name).toBe(false);
    }
  });

  it("still offers deletion when the usage lookup fails", () => {
    // Which environments used a profile is advisory: they hold their own copy
    // of the values, so a failed lookup must not block a local delete.
    const usage = ENVIRONMENT_CREDENTIAL_CLIENT_JS.slice(
      ENVIRONMENT_CREDENTIAL_CLIENT_JS.indexOf("function credentialUsage("),
      ENVIRONMENT_CREDENTIAL_CLIENT_JS.indexOf(
        "function deleteCredentialProfile("
      )
    );
    expect(usage).toContain("/api/list-environments");
    expect(usage).toContain("e.credentialProfile === name");
    expect(usage).toContain(".catch(function() { done([], false); });");
  });

  it("confirms both deletions through the shared dialog, not window.confirm", () => {
    for (const [name, source] of fragments) {
      expect(source.includes("confirm('"), name).toBe(false);
    }
    expect(ENVIRONMENT_CREDENTIAL_CLIENT_JS).toContain("showConfirmDialog({");
    expect(ENVIRONMENT_TABLE_CLIENT_JS).toContain("showConfirmDialog({");
  });

  it("routes dialog text through textContent so names stay inert", () => {
    expect(ENVIRONMENT_CONFIRM_CLIENT_JS).not.toContain("innerHTML");
    expect(ENVIRONMENT_CONFIRM_CLIENT_JS).toContain("li.textContent = item;");
  });

  it("keeps the destructive action off the initially focused control", () => {
    const show = ENVIRONMENT_CONFIRM_CLIENT_JS.slice(
      ENVIRONMENT_CONFIRM_CLIENT_JS.indexOf("function showConfirmDialog("),
      ENVIRONMENT_CONFIRM_CLIENT_JS.indexOf("function closeConfirmDialog(")
    );
    expect(show).toContain("getElementById('env-confirm-cancel').focus()");
    expect(show).not.toContain("getElementById('env-confirm-ok').focus()");
  });

  it("discards the pending action when the dialog closes", () => {
    // A stale callback would let a Cancel followed by an unrelated confirm
    // delete the earlier target.
    expect(ENVIRONMENT_CONFIRM_CLIENT_JS).toContain("pendingConfirm = null;");
    expect(ENVIRONMENT_CONFIRM_CLIENT_JS).toContain(
      "var run = pendingConfirm;\n    closeConfirmDialog();\n    if (run) run();"
    );
  });

  it("addresses only elements the page actually renders", () => {
    // The fragments reach the DOM exclusively by id, so a renamed or relocated
    // element silently breaks behaviour that no page-markup test would notice.
    const rendered = environmentPage({ contextRepo: "octo/app" });
    const renderedIds = new Set(
      [...rendered.matchAll(/id="([^"]+)"/g)].map((match) => match[1])
    );
    for (const [name, source] of fragments) {
      const referenced = new Set(
        [...source.matchAll(/getElementById\('([^']+)'\)/g)].map(
          (match) => match[1]
        )
      );
      expect(referenced.size, name).toBeGreaterThan(0);
      for (const id of referenced) {
        expect(renderedIds.has(id), `${name} addresses missing #${id}`).toBe(
          true
        );
      }
    }
  });
});
