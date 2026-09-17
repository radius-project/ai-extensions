import { escapeHtml, type GraphReadEvidence } from "../shared.js";
import { GRAPH_EVIDENCE_STATUS_ID } from "./graph-evidence-id.js";

export function renderGraphEvidence(
  evidence: GraphReadEvidence | undefined
): string {
  let message = "";
  if (evidence?.unavailable)
    message = `Unavailable: ${evidence.reason}: ${evidence.message}`;
  else if (evidence && "kind" in evidence.result) {
    const result = evidence.result;
    const sources =
      "base" in result ? [result.base, result.head]
      : result.provenance ? [result.provenance]
      : [];
    message = `${
      result.kind === "planned" ?
        "Expected recipe outputs, not a guaranteed deployment plan"
      : result.kind === "deployed" ? "Deployed observation"
      : "Authored source"
    }: ${sources.map((source) => `${source.repo} · ${source.kind === "git" ? `${source.ref} · ${source.commit}` : `${source.branch} · ${source.fingerprint}`}`).join(" → ")}.`;
  }
  return `<p id="${GRAPH_EVIDENCE_STATUS_ID}" role="status" aria-live="polite" class="rad-lede">${escapeHtml(message)}</p>`;
}
