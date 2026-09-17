import { GRAPH_EVIDENCE_STATUS_ID } from "../../pages/graph-evidence-id.js";
import { isRecord, readString } from "../json.js";
import type { BrowserContext } from "../ports.js";

export function updateGraphEvidence(
  context: BrowserContext,
  payload: unknown,
  kind: "authored" | "planned" | "diff"
): void {
  const element = context.dom.byId(GRAPH_EVIDENCE_STATUS_ID);
  if (!element || !isRecord(payload)) return;
  if (payload.unavailable === true) {
    element.textContent = `Unavailable: ${readString(payload, "reason")}: ${readString(payload, "error") || readString(payload, "message")}`;
    return;
  }
  const result = isRecord(payload.result) ? payload.result : undefined;
  const provenance =
    result ?
      kind === "diff" ?
        { base: result.base, head: result.head }
      : result.provenance
    : payload.provenance;
  if (!isRecord(provenance)) return;
  const sourceText = (source: unknown): string =>
    `${readString(source, "repo")} · ${readString(source, "ref") || readString(source, "branch")} · ${readString(source, "commit") || readString(source, "fingerprint")}`;
  element.textContent = `${kind === "planned" ? "Expected recipe outputs, not a guaranteed deployment plan" : "Authored source"}: ${kind === "diff" ? `${sourceText(provenance.base)} → ${sourceText(provenance.head)}` : sourceText(provenance)}.`;
}
