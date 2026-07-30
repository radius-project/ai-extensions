// Reading, rewriting and comparing the `uses:` references in a workflow file.
//
// Everything here is a text operation on YAML, deliberately NOT a parse-and-
// re-serialize. A YAML round-trip is not format preserving — it reindents, drops
// blank lines between blocks and drops a leading `---` — so rewriting two action
// refs would land as a whole-file diff no reviewer can read. Patching the `@ref`
// token in place keeps the commit (or pull request) to the lines that actually
// changed, which is what makes the upgrade auditable in practice.

import {
  isCommitSha,
  ledgerIndex,
  resolvePin,
  type ActionPin,
  type Pinset,
} from "./pinset.js";

/**
 * `uses:` on its own line, optionally as a list item, optionally quoted, with an
 * optional trailing comment. Anchored per line so nothing else in the file can
 * match.
 */
const USES_LINE =
  /^(?<lead>[ \t]*(?:-[ \t]+)?)uses:(?<gap>[ \t]+)(?<quote>['"]?)(?<value>[^'"\s#]+)\k<quote>(?<tail>[ \t]*(?:#.*)?)$/;

/** A reference the extension never rewrites: local workflow, docker image. */
function isExternalAction(value: string): boolean {
  return !/^\.{1,2}\//.test(value) && !value.startsWith("docker://");
}

/** One `uses:` reference found in a workflow file. */
export interface CommittedPin {
  /** `owner/repo[/path]` — the reference with its `@ref` removed. */
  target: string;
  /** `owner/repo`. */
  repo: string;
  /** Sub-path within the repo, `""` for a repo-root action. */
  path: string;
  /** Whatever followed `@`: a SHA, tag or branch. */
  ref: string;
  /** The trailing `# comment` value, `""` when there is none. */
  version: string;
  /** 1-based line number in the source file. */
  line: number;
}

function splitTarget(value: string): { target: string; repo: string; path: string; ref: string } | null {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  const target = value.slice(0, at);
  const ref = value.slice(at + 1);
  const parts = target.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { target, repo: `${parts[0]}/${parts[1]}`, path: parts.slice(2).join("/"), ref };
}

/**
 * Every external `uses:` reference in a workflow, in file order. Local
 * (`./…`) and `docker://` references are skipped — they carry no upstream ref.
 */
export function readActionPins(yaml: string): CommittedPin[] {
  const found: CommittedPin[] = [];
  const lines = yaml.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = USES_LINE.exec(lines[index]);
    if (!match?.groups) continue;
    const value = match.groups.value;
    if (!isExternalAction(value)) continue;
    const split = splitTarget(value);
    if (!split) continue;
    const comment = /#\s*(\S+)/.exec(match.groups.tail ?? "");
    found.push({ ...split, version: comment ? comment[1] : "", line: index + 1 });
  }
  return found;
}

/**
 * Rewrite every `uses:` reference the pinset governs to its pinned SHA, leaving
 * every other byte of the file untouched. References outside the pinset
 * (`actions/checkout`, `azure/login`, …) are left alone: pinning those is the
 * upstream template's decision, not this extension's.
 */
export function pinActionRefs(yaml: string, pinset: Pinset): string {
  const lines = yaml.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = USES_LINE.exec(lines[index]);
    if (!match?.groups) continue;
    const { lead, gap, quote, value } = match.groups as Record<string, string>;
    if (!isExternalAction(value)) continue;
    const split = splitTarget(value);
    if (!split) continue;
    const pin = resolvePin(pinset, split.repo, split.path);
    if (!pin) continue;
    const comment = pin.version ? ` # ${pin.version}` : "";
    lines[index] = `${lead}uses:${gap}${quote}${split.target}@${pin.sha}${quote}${comment}`;
  }
  return lines.join("\n");
}

export type PinStatus = "current" | "outdated" | "ahead" | "unpinned" | "unknown";

/** One reference that would change, with where it is and what it becomes. */
export interface PinChange {
  target: string;
  repo: string;
  status: PinStatus;
  from: { ref: string; version: string; line: number };
  to: { sha: string; version: string };
}

export interface UpgradeFile {
  /** Repo-relative path, e.g. `.github/workflows/run-rad-commands-azure.yml`. */
  path: string;
  changes: PinChange[];
}

export interface UpgradePlan {
  status: "current" | "outdated";
  files: UpgradeFile[];
}

/** Whether a status means the file must be rewritten before deploying. */
function needsUpgrade(status: PinStatus): boolean {
  return status === "outdated" || status === "unpinned" || status === "unknown";
}

/**
 * Classify one committed reference against the pin the frontend requires.
 *
 * A SHA absent from the ledger is `unknown`, never `ahead`: an unrecognised pin
 * must fail towards prompting, so a hand-edited or typo'd ref can never quietly
 * suppress the check.
 */
export function classifyPin(committed: CommittedPin, pin: ActionPin, pinset: Pinset): PinStatus {
  if (committed.ref === pin.sha) return "current";
  if (!isCommitSha(committed.ref)) return "unpinned";
  const committedIndex = ledgerIndex(pinset, committed.repo, committed.ref);
  if (committedIndex === -1) return "unknown";
  const requiredIndex = ledgerIndex(pinset, pin.repo, pin.sha);
  if (requiredIndex === -1) return "unknown";
  if (committedIndex > requiredIndex) return "ahead";
  return committedIndex < requiredIndex ? "outdated" : "current";
}

/**
 * Compare the workflow files already in a repository against the pinset.
 *
 * `committed` maps repo-relative path to file body. A path whose body is empty
 * or absent is not reported: authoring a missing workflow belongs to environment
 * creation, not to an upgrade.
 */
export function comparePins(committed: Record<string, string>, pinset: Pinset): UpgradePlan {
  const files: UpgradeFile[] = [];
  for (const [path, body] of Object.entries(committed)) {
    if (!body) continue;
    const changes: PinChange[] = [];
    for (const found of readActionPins(body)) {
      const pin = resolvePin(pinset, found.repo, found.path);
      if (!pin) continue;
      const status = classifyPin(found, pin, pinset);
      if (!needsUpgrade(status)) continue;
      changes.push({
        target: found.target,
        repo: found.repo,
        status,
        from: { ref: found.ref, version: found.version, line: found.line },
        to: { sha: pin.sha, version: pin.version },
      });
    }
    if (changes.length) files.push({ path, changes });
  }
  return { status: files.length ? "outdated" : "current", files };
}

/** One-line-per-change summary used in commit messages, PR bodies and logs. */
export function describePlan(plan: UpgradePlan): string[] {
  const lines: string[] = [];
  for (const file of plan.files) {
    lines.push(file.path);
    for (const change of file.changes) {
      const from = change.from.version || change.from.ref;
      lines.push(`  ${change.target}: ${from} -> ${change.to.version} (${change.status})`);
    }
  }
  return lines;
}
