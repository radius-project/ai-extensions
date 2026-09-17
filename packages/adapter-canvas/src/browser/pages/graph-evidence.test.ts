import { describe, expect, it } from "vitest";
import {
  createFakeBrowser,
  createFakeElement
} from "../../../test/support/browser/fakes.js";
import { authoredResponse } from "../../../test/support/canonical-graphs.js";
import { GRAPH_EVIDENCE_STATUS_ID } from "../../pages/graph-evidence-id.js";
import { updateGraphEvidence } from "./graph-evidence.js";

describe("browser graph evidence", () => {
  it("ignores missing hosts and malformed or non-evidence payloads", () => {
    const browser = createFakeBrowser();
    updateGraphEvidence(browser.context, {}, "authored");
    const host = createFakeElement(GRAPH_EVIDENCE_STATUS_ID);
    host.textContent = "Existing provenance";
    browser.document.add(host);
    for (const payload of [undefined, [], {}, { provenance: null }])
      updateGraphEvidence(browser.context, payload, "authored");
    expect(host.textContent).toBe("Existing provenance");
  });
  it.each(["error", "message"])(
    "writes unavailable %s as text, never HTML",
    (field) => {
      const browser = createFakeBrowser();
      const host = createFakeElement(GRAPH_EVIDENCE_STATUS_ID);
      browser.document.add(host);
      updateGraphEvidence(
        browser.context,
        {
          unavailable: true,
          reason: "RESULT_UNAVAILABLE",
          [field]: "<img onerror=alert(1)>"
        },
        "planned"
      );
      expect(host.textContent).toBe(
        "Unavailable: RESULT_UNAVAILABLE: <img onerror=alert(1)>"
      );
      expect(host.innerHTML).not.toContain("<img");
    }
  );
  it.each(["authored", "planned", "diff"] as const)(
    "consumes serialized and live %s provenance",
    (kind) => {
      const browser = createFakeBrowser();
      const host = createFakeElement(GRAPH_EVIDENCE_STATUS_ID);
      browser.document.add(host);
      const source = authoredResponse().result.provenance;
      const provenance =
        kind === "diff" ? { base: source, head: source } : source;
      updateGraphEvidence(browser.context, { provenance }, kind);
      const live = host.textContent;
      expect(live).toContain("owner/repo");
      expect(live).toContain("a".repeat(40));
      expect(live).toContain(
        kind === "planned" ?
          "not a guaranteed deployment plan"
        : "Authored source"
      );
      host.textContent = "";
      updateGraphEvidence(
        browser.context,
        {
          unavailable: false,
          result: kind === "diff" ? provenance : { provenance }
        },
        kind
      );
      expect(host.textContent).toBe(live);
    }
  );
  it("shows workspace fingerprints without treating authored data as deployed", () => {
    const browser = createFakeBrowser();
    const host = createFakeElement(GRAPH_EVIDENCE_STATUS_ID);
    browser.document.add(host);
    updateGraphEvidence(
      browser.context,
      {
        provenance: {
          repo: "o/r",
          branch: "work",
          fingerprint: "sha256:fingerprint"
        }
      },
      "authored"
    );
    expect(host.textContent).toBe(
      "Authored source: o/r · work · sha256:fingerprint."
    );
  });
});
