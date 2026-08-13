# Producer contract fixtures

Files here are **captured verbatim from real runs of the producer**, not hand-written. They exist so a one-sided change to the deploy-status contract fails a test instead of failing silently.

## Why this matters

The producer (`radius-project/radius`, the `publish-deploy-status` composite action) and this consumer are in different repositories. A coordinated rename in both is fine. A one-sided change in the **consumer** is the dangerous case: the reader stops recognizing what the producer emits, the Deployed tab renders an empty graph, and nothing anywhere turns red. That failure mode is exactly what the previous GHCR transport suffered from, and it is why lookup now confirms identity from the payload rather than from a name derived twice.

`deploy-artifacts.test.ts` parses these fixtures through the real reader code. The producer has the mirror-image test asserting it still emits this shape.

## Files

| File                   | Captured from                                            | Exercises                                                                                                               |
|------------------------|----------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| `deploy-progress.json` | A real run, artifact `radius-deploy-status-dev-todolist` | All three status branches (`success`, `failed`, `in_progress`), a populated failure `message`, and an empty-string `id` |

The empty-string `id` on the `queue` resource is deliberate and load-bearing. `rad resource list -o json` does not always populate an id, and the producer emits `""` rather than omitting the field. If `""` were ever treated as a real key, every id-less resource in a payload would collide on one map entry and take each other's status.

## Changing a fixture

Do not edit these by hand to make a test pass. If a real payload stops matching, fix the contract at its source — raise it with the producer and change both sides together. Re-capture the fixture from an actual run rather than editing it toward what the consumer happens to expect.

## Provenance, and why the structural assertion exists

A payload once reached this repository with `updatedAt` dropped in transit, and the omission was briefly read as evidence that the producer did not emit that field — which nearly relaxed the documented contract to match a corrupted sample. The producer emits it unconditionally.

A fixture is only trustworthy if it is checked *against* the contract rather than treated as the definition of it. `deploy-artifacts.test.ts` therefore asserts the fixture's top-level and per-resource key sets structurally, so a truncated or hand-edited fixture fails loudly instead of quietly weakening what the reader expects.

The general rule: capture fixtures by running the producer, not by copying a payload out of a message. Every hop that a payload passes through by hand is a chance for it to lose a field.
