// Opt-in mechanical parity check for the ported `.github/extension/` tree.
//
// Why this exists: the Repo Radius workflow contract (workflow templates +
// composite actions + shell/TS helpers) was ported into this repo from
// radius-project/radius so that ai-extensions becomes the single source of
// truth. A partial or stale port is dangerous — the extension already resolves
// composite actions and templates from `radius-project/ai-extensions`, so any
// asset that was missed or that silently diverged would ship broken workflows
// into user repos. This test mechanically proves that this repo's
// `.github/extension/` tree equals the Radius tree it was ported from, after a
// small, explicit transform, so drift or a dropped file fails a check instead
// of reaching users.
//
// It is pinned to the exact Radius commit the port was taken from
// (RADIUS_PARITY_REF) rather than a floating `main`, so it is deterministic and
// does not start failing when Radius moves on or when the duplicated tree is
// finally deleted from Radius. When Radius parity is intentionally advanced,
// bump RADIUS_PARITY_REF to the new commit and re-run the port.
//
// This is a temporary migration guard: delete it once
// radius-project/radius#12719 lands and removes the duplicated
// `.github/extension/` tree from Radius. At that point ai-extensions is the
// sole source of truth, there is no upstream tree left to compare against, and
// the parity check has served its purpose.
//
// The transform is the same repointing applied during the port: every
// `radius-project/radius/.github/extension` reference (composite-action `uses:`
// refs and doc links) becomes `radius-project/ai-extensions/.github/extension`,
// and the one prose comment naming where the shared actions live is repointed
// too. Two files intentionally diverge beyond that transform and are compared
// only for existence, not content: `actions/load-contrib-catalog/action.yml`
// (reworked to be self-contained — it fetches the Radius-owned catalog by ref
// and installs yq from a co-located script, because ai-extensions has no
// in-repo `deploy/manifest/defaults.yaml` or Makefile) and `README.md` (updated
// to describe that fetch-by-ref behavior). One file exists only here and has no
// Radius counterpart: `actions/load-contrib-catalog/install-yq.sh`.
//
// Like the other `*.live.test.ts` suites this hits the network, so it is gated
// on RUN_LIVE_WORKFLOW_TESTS and runs in the separate live-tests workflow, not
// the hermetic build suite.
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { githubApiHeaders } from "../../test/support/live-github.js";

const LIVE = !!process.env.RUN_LIVE_WORKFLOW_TESTS;

// The Radius commit this repo's `.github/extension/` tree was ported from.
// Pinned (not `main`) so parity is deterministic and immune to later Radius
// changes, including the eventual removal of the duplicated tree.
const RADIUS_PARITY_REF =
  process.env.RADIUS_PARITY_REF?.trim() ||
  "921e55c69ab19ed160ded2d19a9126b57e15f82b";

const RADIUS_REPO = "radius-project/radius";
const EXTENSION_DIR = ".github/extension";

// The mechanical port transform: repoint every extension-tree reference from
// radius-project/radius to radius-project/ai-extensions, plus the single prose
// comment that names where the shared composite actions live.
const T1_FROM = "radius-project/radius/.github/extension";
const T1_TO = "radius-project/ai-extensions/.github/extension";
const T2_FROM = "shared composite actions in radius-project/radius;";
const T2_TO = "shared composite actions in radius-project/ai-extensions;";

function applyPortTransform(text: string): string {
  return text.split(T1_FROM).join(T1_TO).split(T2_FROM).join(T2_TO);
}

// Paths (relative to `.github/extension/`) that intentionally diverge from
// Radius beyond the transform. They are required to EXIST but their content is
// not byte-compared.
const CONTENT_EXCEPTIONS = new Set<string>([
  "README.md",
  "actions/load-contrib-catalog/action.yml"
]);

// Paths that exist only in ai-extensions and have no Radius counterpart.
const ADDITIONS = new Set<string>([
  "actions/load-contrib-catalog/install-yq.sh",
  // The environment-delete Azure provider is authored and owned here (issue
  // #303); Radius has no counterpart, so it is an intentional addition.
  "delete-environment-azure.yml"
]);

interface RadiusBlob {
  path: string; // relative to EXTENSION_DIR
  sha: string;
  mode: string; // git file mode, e.g. 100644 / 100755
}

// GitHub returns 403 for both permission and rate-limit failures; the parity
// job may run unauthenticated, where the anonymous limit is only 60/hour, so
// name that explicitly to make CI failures actionable (set GITHUB_TOKEN).
function describeFetchFailure(res: Response): string {
  if (res.status === 403 || res.status === 429) {
    return `${res.status} ${res.statusText} (likely GitHub API rate limiting; set GITHUB_TOKEN to raise the limit)`;
  }
  return `${res.status} ${res.statusText}`;
}

// Resolve `items` through `fn` with a bounded number in flight so a large tree
// does not open dozens of simultaneous connections and trip GitHub secondary
// rate limits.
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  const workers: Promise<void>[] = [];
  const parallel = Math.min(limit, items.length);
  for (let i = 0; i < parallel; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

async function fetchRadiusExtensionBlobs(ref: string): Promise<RadiusBlob[]> {
  const encodedRef = encodeURIComponent(ref);
  const url = `https://api.github.com/repos/${RADIUS_REPO}/git/trees/${encodedRef}?recursive=1`;
  const res = await fetch(url, {
    headers: githubApiHeaders("application/vnd.github+json")
  });
  if (!res.ok) {
    throw new Error(
      `failed to fetch Radius tree ${url}: ${describeFetchFailure(res)}`
    );
  }
  const body = (await res.json()) as {
    tree: { path: string; type: string; sha: string; mode: string }[];
  };
  const prefix = `${EXTENSION_DIR}/`;
  return body.tree
    .filter((e) => e.type === "blob" && e.path.startsWith(prefix))
    .map((e) => ({
      path: e.path.slice(prefix.length),
      sha: e.sha,
      mode: e.mode
    }));
}

async function fetchRadiusBlob(sha: string): Promise<Buffer> {
  const url = `https://api.github.com/repos/${RADIUS_REPO}/git/blobs/${sha}`;
  const res = await fetch(url, {
    headers: githubApiHeaders("application/vnd.github+json")
  });
  if (!res.ok) {
    throw new Error(
      `failed to fetch Radius blob ${sha}: ${describeFetchFailure(res)}`
    );
  }
  const body = (await res.json()) as { content: string; encoding: string };
  return Buffer.from(body.content, body.encoding as BufferEncoding);
}

// Repo root is four levels up from this file (src/workflows -> src -> core ->
// packages -> repo root).
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

async function readLocalExtensionFile(rel: string): Promise<Buffer> {
  return readFile(resolve(REPO_ROOT, EXTENSION_DIR, rel));
}

// The transform only ever touches text files that contain the ASCII tokens, so
// binary/prebuilt assets (e.g. the artifact-uploader bundle) are compared as
// raw bytes without a lossy utf-8 round trip.
function expectedLocalBytes(radiusBytes: Buffer): Buffer {
  if (radiusBytes.includes(T1_FROM) || radiusBytes.includes(T2_FROM)) {
    return Buffer.from(
      applyPortTransform(radiusBytes.toString("utf8")),
      "utf8"
    );
  }
  return radiusBytes;
}

describe.skipIf(!LIVE)(
  "extension tree parity with Radius (opt-in: set RUN_LIVE_WORKFLOW_TESTS)",
  () => {
    it("has every Radius extension asset, no unexpected extras, and no content drift", async () => {
      const blobs = await fetchRadiusExtensionBlobs(RADIUS_PARITY_REF);
      expect(
        blobs.length,
        `expected to find Radius extension assets at ${RADIUS_PARITY_REF}`
      ).toBeGreaterThan(0);

      const radiusPaths = new Set(blobs.map((b) => b.path));

      const localPaths = new Set<string>();
      const localModes = new Map<string, string>();
      // Discover local files by asking git for the tracked set under the tree,
      // so an accidentally-ignored asset (e.g. a prebuilt bundle under a
      // `dist/` dir) is caught as a missing file rather than silently skipped.
      // `-s` also yields each blob's mode so we can compare the executable bit
      // against Radius (a lost +x on a shell action would break at runtime).
      const { execFileSync } = await import("node:child_process");
      const tracked = execFileSync("git", ["ls-files", "-s", EXTENSION_DIR], {
        cwd: REPO_ROOT,
        encoding: "utf8"
      })
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const line of tracked) {
        // Format: "<mode> <sha> <stage>\t<path>", e.g. "100644 <sha> 0\tfoo".
        const [meta, fullPath] = line.split("\t");
        const mode = meta.split(" ")[0];
        const rel = fullPath.slice(`${EXTENSION_DIR}/`.length);
        localPaths.add(rel);
        localModes.set(rel, mode);
      }

      // Every Radius asset must be present here.
      const missing = [...radiusPaths].filter((p) => !localPaths.has(p));
      expect(
        missing,
        `Radius extension assets missing from ai-extensions (port is incomplete): ${missing.join(", ")}`
      ).toEqual([]);

      // No unexpected extra files (only the documented additions are allowed).
      const extra = [...localPaths].filter(
        (p) => !radiusPaths.has(p) && !ADDITIONS.has(p)
      );
      expect(
        extra,
        `ai-extensions has extension files with no Radius counterpart (not in the additions allowlist): ${extra.join(", ")}`
      ).toEqual([]);

      // File-mode parity: Git only tracks 100644 (regular) vs 100755
      // (executable), so a shell action that lost its +x bit in the port would
      // pass the byte-content check yet fail to run. Compare modes for every
      // shared Radius blob.
      const modeDrift: string[] = [];
      for (const b of blobs) {
        const local = localModes.get(b.path);
        if (local !== b.mode) {
          modeDrift.push(`${b.path} (radius ${b.mode}, local ${local})`);
        }
      }
      expect(
        modeDrift.sort(),
        `these ai-extensions files have a different git file mode than Radius@${RADIUS_PARITY_REF}: ${modeDrift.join(", ")}`
      ).toEqual([]);

      // Content parity for every shared file except the documented exceptions.
      const drift: string[] = [];
      // Cap in-flight blob fetches so a large tree does not fire ~60 concurrent
      // requests at the GitHub API and trip secondary rate limiting.
      await mapWithConcurrency(blobs, 8, async (blob) => {
        if (CONTENT_EXCEPTIONS.has(blob.path)) {
          return;
        }
        const radiusBytes = await fetchRadiusBlob(blob.sha);
        const expected = expectedLocalBytes(radiusBytes);
        const local = await readLocalExtensionFile(blob.path);
        if (!expected.equals(local)) {
          drift.push(blob.path);
        }
      });
      expect(
        drift.sort(),
        `these ai-extensions files diverge from Radius@${RADIUS_PARITY_REF} beyond the port transform: ${drift.join(", ")}`
      ).toEqual([]);
    }, 60_000);
  }
);
