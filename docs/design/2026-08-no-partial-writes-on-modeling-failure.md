# No partial writes when modeling fails

- **Author**: Karishma Chawla (@kachawla)
- **Date**: 2026-08
- **Status**: Draft
- **Tracks**: [radius-project/ai-extensions#97](https://github.com/radius-project/ai-extensions/issues/97), case 2.4

## Current state

Modeling writes into `.radius/` as it goes, in this order:

1. `.radius/custom-types.yaml`, and the published `.radius/custom-types.tgz`, when the app needs a custom type
2. `.radius/bicepconfig.json`
3. `.radius/app.bicep`
4. `.radius/app.origin.json`, written last, once the Bicep checker passes
5. `git add` of all of the above

Nothing about that sequence is transactional. If modeling stops partway — the source cannot be read, a schema lookup fails, the Bicep extension cannot be downloaded, the run is cancelled — whatever was written by then stays on disk, and may already be staged. Two things go wrong. A repository that had no app model now has a half-written one. A repository that had a *working* app model now has it partly overwritten by a run that never finished.

There is also no retry. The user is told it failed, and what happens next depends on whether the agent decides to try again.

Stale-model detection ([#399](https://github.com/radius-project/ai-extensions/pull/399)) reduces the blast radius but does not solve this. Because the origin record is written last, a half-written model shows up as `missing` or `unrecorded` on the next graph open, so it is not rendered as if it were real. But the partial files are still on disk, still staged, and the previous good model is still gone.

## Proposal

Have modeling build the whole set of files somewhere else, and only move them into `.radius/` once every one of them is complete and the app model has compiled. A failure anywhere before that point leaves `.radius/` exactly as it was.

## Objectives

### Goals

1. A failed modeling run leaves `.radius/` byte-identical to what it was before the run started.
2. A failed modeling run stages nothing.
3. The user is told the run failed and offered a retry, and a retry starts from a clean slate.

### Non-goals

1. **Resuming a failed run partway through.** A retry re-runs modeling from the start. Partial work is thrown away, not repaired.
2. **Deciding whether a failure is worth retrying automatically.** The offer is made to the user; it is not an automatic retry loop.
3. **Protecting against a machine losing power mid-promote.** The promote is a small number of file moves within one directory, which is as close to atomic as is worth engineering here.

## Design

### A staging directory

Modeling writes to `.radius/.staging-<runId>/` instead of writing into `.radius/` directly. Nothing the run produces lands where the product reads it until the run has finished and passed its checks.

The staging directory lives inside `.radius/`, not in the system temp directory. That is because of how moving a file works. Moving a file within one filesystem is a rename: the file's contents never move, only the name pointing at them changes, and it either happens or it does not. Moving a file between two filesystems is really a copy followed by a delete, which takes as long as the file is large and can fail halfway, leaving a partial file behind. A system temp directory is very often a different filesystem from the user's repository — a separate volume on macOS and Linux, potentially a different drive on Windows. Keeping the staging directory inside `.radius/` guarantees the same filesystem, so publishing the finished run is a rename and cannot half-happen. That is the property this whole design depends on, so it is worth buying outright rather than hoping the two paths land on the same volume.

Keeping it there has a second, smaller benefit: everything a run produced is sitting next to everything it was going to replace, which makes a failed run easy to look at while debugging.

The skill's file-writing steps all target the staging directory. `radius_publish_custom_type_extension`, which today confines its paths to `.radius/`, is extended to accept the staging directory as a valid target so the published `custom-types.tgz` lands with the rest of the run's output. The Bicep checker runs against the staged `app.bicep`, so what is verified is exactly what will be published.

### Promote

A new script, `scripts/promote-app-model.mjs`, does the move. The skill calls it as the last step of modeling. It is a script rather than a prompt instruction so that "the model was only published because everything succeeded" is enforced by code and cannot be skipped by an agent that decides it is close enough.

It checks, in order:

| Check                                                        | If it fails                    |
|--------------------------------------------------------------|--------------------------------|
| Does the staging directory hold a complete set of files?     | Refuse; leave `.radius/` alone |
| Does `app.origin.json` exist and match `app.bicep`?          | Refuse; leave `.radius/` alone |
| Is the app model on disk still the one the run started from? | Refuse; leave `.radius/` alone |

A complete set is `app.bicep`, `bicepconfig.json`, `app.origin.json`, and — only when the run generated a custom type — `custom-types.yaml` and `custom-types.tgz`. Because the origin record is only written once the Bicep checker passes, requiring it here also means an app model that never compiled can never be published. The origin record is the same file `.radius/app.origin.json` that stale-model detection introduced, and it is what marks a generated file as a real app model.

Once all three checks pass, the script moves each file into `.radius/`, removes the staging directory, and stages the published files with `git add`. Staging moves to the end, so a failed run has nothing in the index.

### Publishing over an app model the user changed

The third check is the concurrent-edit case: the user hand-edits `.radius/app.bicep` while a modeling run is in progress, and the run finishes afterwards and overwrites it.

This design exists to stop the product destroying the user's working state, so leaving open the one path that still destroys it would be a strange place to stop. It is also nearly free to close. Modeling already fingerprints the app model — stale-model detection hashes it to tell a generated file from an edited one — so this is one extra hash taken when the run starts and compared at the end, using code that already exists.

On a mismatch the promote refuses, the staged output is discarded, and the user is told their edit is intact and that the run did not publish. They can re-run modeling when they are ready.

Refusing discards a model that took minutes to produce, which is a real cost. The alternative is to hold the staged output and ask which version to keep, which is what stale-model detection does when it finds an edited app model. That is a better experience and a worse first implementation: it needs the staged run to outlive the turn that produced it, and a promote that can be resumed later. Since the user is one message away from re-running, and this case is rare to begin with, the cheap version is enough until someone hits it often enough to complain.

### Cleanup

A staging directory left behind by an interrupted run is removed the next time modeling runs, before the new run starts. Any `.radius/.staging-*` directory is fair game, since a run that finished always removes its own. `.radius/.staging-*` is also added to the repository's ignore rules by the same step that writes `bicepconfig.json`, so an interrupted run cannot leave untracked noise in the user's `git status`.

### Failure and retry

When any modeling step fails, the skill deletes its staging directory and reports what failed. It does not retry on its own, because a second identical attempt is only worth making for a transient failure, and the skill is not in a good position to tell a transient failure from a permanent one.

Instead it says which of the two it looks like, and asks:

- **Looks transient** — a network error fetching a schema, a registry timeout, an interrupted download. Offer to run modeling again.
- **Looks permanent** — the repository has no Dockerfile, a required backing service has no Radius type and cannot be provisioned on Azure, the source cannot be resolved to a runnable profile. Report it and do not offer a retry, because the same run would fail the same way.

Either way the message states plainly that nothing was written, so the user knows their existing app model, if they had one, is intact.

The staging directory is always deleted on failure, never kept for inspection. What a user needs in order to act is in the failure message, and what an engineer needs is in the logs. A directory of half-finished files is mostly a way to mistake a discarded run for a real app model, and keeping it would leave the product with two places an app model might live.

## Alternatives considered

**Back up `.radius/` and restore it on failure.** Simpler to write, but it inverts the risk: the window where the repository is in a bad state is the whole modeling run rather than the few milliseconds of the promote, and a failure *during the restore* leaves the user worse off than doing nothing. Staging keeps `.radius/` untouched for the entire run.

**Leave it to prompt rules — tell the skill to clean up after itself.** This is roughly the status quo, and it fails in exactly the cases that matter. A run that is cancelled or crashes never reaches the instruction telling it to clean up.

**Ask which version to keep when the user edited the app model mid-run.** Better than refusing, and it matches what stale-model detection already does for an edited app model. Deferred rather than rejected: it needs a staged run that outlives the turn that produced it, and a promote that can be resumed. See [Publishing over an app model the user changed](#publishing-over-an-app-model-the-user-changed).
