# Deployed graph retrieval (workflow artifacts)

The canvas "Deployed" tab renders the application graph a deploy actually produced, painted with per-resource deploy status. This document is the normative producer/consumer interface: the artifact the GitHub Actions deploy workflow publishes, and how the canvas finds, validates, and applies it.

## Why workflow artifacts

There is no GitHub API that exposes a running job's log output, so the deploy's own stdout cannot be used as a live signal. This was verified empirically:

- `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` returns 200 but withholds the currently-running step. A controlled workflow printing a line every two seconds showed zero lines for three minutes, then all 91 at once when the job completed.
- The GitHub web UI's live view calls `/{owner}/{repo}/commit/{sha}/checks/{id}/logs/{n}`, which returns 404 even with a full repo-scope token. It is session-cookie-only.
- `gh run watch` streams step status with no log content.

Workflow artifacts have the property that logs lack: `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts` is listable **and** downloadable while a run is still in progress. `GET /repos/{owner}/{repo}/actions/artifacts` returns newest-first repo-wide, which is how a fresh canvas session finds the last deploy without knowing a run id.

This replaces an earlier GHCR OCI-artifact transport, and an earlier `radius-deploy-status` git orphan branch. Neither is read anymore.

## Artifact name

```text
radius-deploy-status-<environment>-<app>
radius-deploy-status-<environment>-<app>-live-<run-id>-slot-<0..7>
```

The fixed name is the terminal artifact. During an application deploy, changed resource snapshots rotate through the eight run-scoped live slots. Slot names bound artifact count; they do not define ordering. The payload's `runId` and `sequence` are authoritative.

The producer builds this as the literal prefix `radius-deploy-status-` followed by `printf '%s-%s' "$ENVIRONMENT" "$APP_NAME"` sanitized with:

```bash
LC_ALL=C tr '[:upper:]' '[:lower:]' \
  | LC_ALL=C sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//' \
  | LC_ALL=C cut -c1-80
```

**Lookup never depends on reproducing that name exactly.** The previous GHCR transport derived its tag independently in bash and in TypeScript and compared for equality; when the two derivations disagreed — most often over how the application name was resolved — the Deployed tab silently stayed empty. The consumer therefore matches by prefix and confirms identity from the payload, in two tiers:

1. Artifact names starting with `radius-deploy-status-<sanitized-environment>-`.
2. When tier 1 matches nothing, names starting with the bare literal `radius-deploy-status-`. This recovers the case where the producer's `cut -c1-80` truncated into or past the application segment (a long environment name), and any future divergence in the sanitizer.

In both tiers the artifact is accepted only when its payload reports an application and environment matching the current selection, compared case-insensitively after sanitization. Expired artifacts are skipped, since their bytes are gone.

The two sanitizer implementations agree on multi-byte input even though `sed` counts bytes and JavaScript counts UTF-16 code units: every character outside `[a-z0-9._-]` is outside the class in both, so a multi-byte character is a single run either way and collapses to one `-`. The length cap is likewise safe, because by the time it applies the string is pure ASCII.

## Files in the artifact

| File                      | When         | Purpose                                                |
|---------------------------|--------------|--------------------------------------------------------|
| `deploy-progress.json`    | Every upload | Per-resource status map — the status signal            |
| `deploy-graph.json`       | Final upload | Deployed application graph from `rad app graph`        |
| `deploy-state.txt`        | Every upload | Key/value run envelope. Not read by the canvas.        |
| `deploy-controlplane.log` | Best effort  | Control-plane / recipe output                          |
| `deploy-activity.log`     | Best effort  | `rad` command result envelope. Not read by the canvas. |

Live uploads carry `deploy-progress.json` with state `in_progress`. The fixed-name terminal upload carries the complete file set and a sequence one greater than the last successful live upload, or sequence 1 when no live upload succeeded. `sequence` is always a positive integer; the reader rejects a payload without one.

`application` and `environment` inside the payload are the **raw** values, not sanitized: a run in environment `My Env/Prod` emits `"environment": "My Env/Prod"` while the artifact name carries `my-env-prod`. Confirmation sanitizes both sides, so the asymmetry is not a mismatch.

**`deploy-progress.json` is the single authority for run and per-resource state.** `deploy-state.txt` predates this contract and uses a different vocabulary for the same concept — it reports `state=success` where `deploy-progress.json` reports `"state": "succeeded"`. Two vocabularies in one artifact is a latent trap, so the canvas reads neither the state nor any status from `deploy-state.txt`; it is carried for provenance and for other consumers only. Nothing should be derived from it here.

## `deploy-progress.json`

```json
{
  "schemaVersion": 1,
  "application": "todolist",
  "environment": "dev",
  "runId": 1234567890,
  "sequence": 1,
  "updatedAt": "2026-08-06T18:00:00Z",
  "state": "succeeded",
  "resources": [
    {
      "id": "/planes/radius/local/resourcegroups/dev/providers/Radius.Compute/containers/frontend",
      "name": "frontend",
      "type": "Radius.Compute/containers",
      "provisioningState": "Succeeded",
      "status": "success",
      "message": ""
    }
  ]
}
```

| Field                           | Type    | Required | Notes                                                                                                                                                                                                       |
|---------------------------------|---------|----------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `schemaVersion`                 | integer | Yes      | Must be `1`. Any other value is rejected as malformed rather than guessed at.                                                                                                                               |
| `application`                   | string  | Yes      | Radius application name. Confirms the artifact matches the selection.                                                                                                                                       |
| `environment`                   | string  | Yes      | Environment name. Same use.                                                                                                                                                                                 |
| `runId`                         | integer | Yes      | Actions run id. Provenance, and lets the consumer tell one run's snapshots from another's. `0` means the producer had no `GITHUB_RUN_ID` and is treated as unknown.                                         |
| `sequence`                      | integer | Yes      | Monotonic within a run, starting at 1.                                                                                                                                                                      |
| `updatedAt`                     | string  | Yes      | RFC 3339 UTC. Drives the "updated N ago" line in the UI. The producer emits it unconditionally; the reader nonetheless tolerates its absence and omits the age rather than inventing one.                   |
| `state`                         | string  | Yes      | Run level: `in_progress`, `succeeded`, or `failed`.                                                                                                                                                         |
| `resources`                     | array   | Yes      | May be empty. Absent or non-array is malformed.                                                                                                                                                             |
| `resources[].id`                | string  | No       | Full UCP resource id when known. Primary status key. Frequently an empty string, because `rad resource list` does not always populate one; an empty id is treated as absent and never becomes a lookup key. |
| `resources[].name`              | string  | Yes      | Radius resource name. Fallback status key.                                                                                                                                                                  |
| `resources[].type`              | string  | Yes      | Radius resource type. May carry an `@api-version` suffix, which the consumer strips.                                                                                                                        |
| `resources[].provisioningState` | string  | No       | Raw Radius value, verbatim.                                                                                                                                                                                 |
| `resources[].status`            | string  | No       | Normalized: `pending`, `in_progress`, `success`, or `failed`.                                                                                                                                               |
| `resources[].message`           | string  | No       | Short status or failure detail. Surfaced in the node popup as escaped text, never parsed. An empty string means "no message".                                                                               |

### Status resolution

A resource's status is resolved in this order: the normalized `status` when present and one of the four known values; otherwise `provisioningState` mapped through the table below; otherwise `in_progress`.

| `provisioningState`                                | Maps to       |
|----------------------------------------------------|---------------|
| `Succeeded`                                        | `success`     |
| `Failed`, `Canceled`, `Cancelled`                  | `failed`      |
| `Accepted`, `Provisioning`, `Updating`, `Deleting` | `in_progress` |
| Anything else, including absent                    | `in_progress` |

Both fields are carried deliberately. Emitting `status` keeps the mapping decision with the producer, which knows the Radius version it ran against; emitting `provisioningState` lets the consumer recover when the producer's mapping is stale. Unrecognized values map to `in_progress` and never to `failed`, so a provisioning state added by a future Radius release cannot paint the graph red.

### Strict to emit, lenient to accept

The "Required" column above describes what the producer guarantees, not what the reader enforces. The reader is deliberately more permissive: a missing `updatedAt` omits the freshness line rather than failing the read, and a missing `id` falls through to the next lookup tier. Documenting a field as required while accepting its absence is the intended asymmetry — it keeps the producer honest without letting one missing field blank the tab.

The one exception is `schemaVersion`. An unrecognized version is rejected outright, because a payload this reader does not understand cannot be partially trusted: a silently misread status map paints the graph with wrong colors, which is worse than showing nothing.

## Read path

`createDeployStatusReader` in [`packages/adapter-canvas/src/deploy-artifacts.ts`](../../packages/adapter-canvas/src/deploy-artifacts.ts):

1. List artifacts — scoped to the run being monitored when there is one, else newest-first repo-wide.
2. Select up to nine candidates by the two-tier prefix match: eight live slots plus the fixed terminal artifact. Repo-wide reads drop live-slot candidates first, because `sequence` restarts at 1 for every run and a cancelled run's higher-sequenced slot would otherwise beat a newer completed run's terminal artifact.
3. Download uninspected artifact IDs with `gh run download`, validate application and environment identity, and reject an explicit `runId` that differs from the active run.
4. Select the numerically greatest valid `sequence` within an active run; on a repo-wide read (where sequences are only comparable within one run), the newest-listed terminal artifact wins instead.
5. Classify the outcome as `ok`, `missing`, `malformed`, `auth`, `error`, or `stale`.

The repo-wide listing is paginated, which matters more than it appears. One page covers the newest 100 artifacts in the **entire repository**, and a repository whose CI uploads test reports or build output on every push can produce that many between two deploys. Reading only the first page would push the deploy-status artifact off the end and render "Nothing deployed yet" for an application that is in fact deployed — the exact symptom this transport exists to eliminate. Paging stops as soon as a page yields a **non-live-slot** match (the listing is newest-first, so nothing better appears later), at a short page, or at a five-page budget, so a repository with no deploy-status artifact costs a bounded number of calls rather than a walk of its whole history. Live-slot names are ignored by the stop predicate on purpose: a page holding only live slots would otherwise hide the previous deploy's terminal artifact on the next page while a new deploy is mid-flight.

Reads are cached for a short TTL and de-duplicated with single-flight, so the deploy monitor and a concurrent `/api/deployed-graph` request share one fetch. Active-run readers also cache inspected immutable artifact IDs, so each poll downloads only newly published slots. The cache is pruned to the current listing on every poll, because ring slots overwrite by uploading with new IDs and an ID that drops out never returns. Payloads are accepted in monotonic `sequence` order per run, so a stale read — one served just after an overwrite, or arriving out of order — is reported as `stale` and can never roll the graph backwards.

## Rendering

The Deployed tab is a projection, not a distinct graph: a fixed topology painted with a status map resolved separately. `projectDeployedGraph` in [`packages/core/src/graph/deployed.ts`](../../packages/core/src/graph/deployed.ts) applies the shared visualization filter, strips output resources, and stamps each node with its status. Keeping topology and status independent means the graph renders before any status is known and never changes shape when a deploy starts or ends, so React Flow keeps its viewport across every transition.

`GET /api/deployed-graph` accepts `repo`, and optionally `application` and `environment`. The page's selectors are authoritative: a user can select an environment other than the one the current session deployed to, and the graph follows the selection rather than rendering another environment's deploy under the selected environment's label. The response is `{ resources, repo, branch, mode, updatedAt }`, where `mode` is:

- `greyed` — nothing is known about a deployment; the modeled topology renders with every node pending.
- `live` — a deploy is in flight for the current selection.
- `terminal` — a deployment's status is known.

`terminal` is decided by whether any status is known, not by whether a graph was published. The producer attaches `deploy-graph.json` only to its final upload, so a run can report real per-resource status with no graph at all.

`updatedAt` is the payload's own timestamp, so the UI reports the age of the data rather than the age of the last fetch. Polling more often does not make an old deployment newer.

Resources on this route always carry an empty `outputResources`: the Deployed view is one node per Radius resource.

Each node's status is matched to a payload entry by, in priority order, exact `id`, then lowercased `name|type` with the API version stripped, then lowercased `name`. The middle tier matters because modeled resource ids are synthesized locally by `buildResourceID` and are not guaranteed to equal the UCP ids the control plane reports; without it, an id mismatch would silently degrade every node to bare-name matching, which collides across types.

Merging successive snapshots is deliberately conservative, because each payload is an independent snapshot rather than a stream of transitions:

- `failed` is terminal within a run and is never downgraded by a later snapshot.
- `success` regresses only on an explicit `failed`.
- A resource missing from a payload keeps its current status. A payload that does not mention a resource carries no information about it and must not reset a node that has already advanced. This holds for the projection too: projecting against an empty status map leaves a deployed application deployed rather than repainting it pending.
- On the run's terminal conclusion, success forces every node green; any other conclusion fails whatever is still pending or in progress while leaving already-terminal values alone.

A single read inspects at most nine candidate artifacts, enough for the eight live slots and terminal artifact. Each candidate costs a `gh run download` subprocess, a temporary directory and an unzip, so the bounded ring and immutable-ID cache prevent a 15-second poll from repeatedly downloading the same payloads.

## Live progress

The deploy action publishes changed resource snapshots every five seconds through a checked-in bundle of the official `@actions/artifact` client. Reporting is best-effort: poll and upload failures do not change the deploy result, and sequences advance only after successful uploads.

The consumer polls while the run is in progress, validates each payload against the active run, and applies only increasing sequences. After the run completes, the higher-sequence fixed-name terminal artifact wins naturally and provides `deploy-graph.json` plus diagnostics.

## Cadence

The canvas refreshes the graph every 15 seconds while a run is in progress, and says so in the UI. An artifact upload takes several seconds, so polling faster returns identical bytes and consumes API quota; stating the interval means a graph that has not changed reads as "no new data yet" rather than "broken". The deploy log below the graph continues to stream on its own 1.5-second poll and carries the moment-to-moment liveness. Polling pauses while the panel is hidden and resumes when it becomes visible, and survives a transient request failure rather than freezing the graph for the life of the page.

## Contract testing

The producer and this consumer live in different repositories, so nothing structurally prevents one side from drifting. A coordinated change in both is fine; a one-sided change in the **consumer** is the dangerous case, because it fails silently — an empty Deployed graph with nothing red anywhere.

Both sides therefore pin the same real payload. The producer asserts it emits the shape; this repository checks in the captured artifact under [`packages/adapter-canvas/src/fixtures/`](../../packages/adapter-canvas/src/fixtures/README.md) and parses it through the real reader in the normal vitest suite. The fixture deliberately exercises all three status branches, a populated failure `message`, and an empty-string `id`.

Fixtures are captured from real runs, never hand-written to match the consumer. When a real payload stops matching, the contract is fixed at its source rather than accommodated here.

## Permissions

The consumer reads Actions artifacts through the `gh` CLI, using the same repository read access the existing `gh run view` and `gh run list` calls already require. No new credential or scope is involved. A 401 or 403 is classified as `auth` and surfaced distinctly from a missing artifact, since it will not resolve by retrying.
