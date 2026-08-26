---
"radius": patch
---

Stop cutting off a live modeling run, and let every graph page recover once the model lands.

While Copilot authors `.radius/app.bicep`, a graph request answers `needsAppBicep` instead of failing, and the page keeps asking. That wait was bounded by a flat five-minute wall clock, which was long enough only because the application-model prompt used to run before the panel opened. Now that the panel opens first, the clock covers the authoring itself, and modeling a real multi-service repository routinely outlasts it — so the Modeled tab stopped in the middle of a run that was working.

The budget now distinguishes a run that has been observed from a target whose activity cannot be observed. A modeling run creates `.radius/.staging-<runId>/` before it writes anything, but valid modeling phases can spend minutes reading source, resolving schemas, or publishing recipes without another filesystem write. Once a run is observed, only the thirty-minute hard ceiling can stop it. An unobserved target gets five minutes before the page reports that the model has not appeared, without claiming that a remote-branch run never began.

The expiry decision moved to the server, into the single place every graph route's `needsAppBicep` answer passes through. An expired wait arrives as an ordinary error, so no page needs its own clock.

The Planned and Diff tabs also kept their part of the bargain for the first time. Both announced "Copilot is generating .radius/app.bicep…" once and then never asked again, so neither recovered even after the model was written — the panel simply sat there until the user reloaded. Both now retry until the model lands or the server ends the wait, and a fresh page request explicitly starts a new bounded wait after an expiry.

Automatic retries now retain the current generating message instead of flashing the initial branch-check message on every poll. Model handoffs are remembered independently for each repo and branch target within the canvas instance, so reopening that instance after a worktree branch rename cannot make its old iframe dispatch the same prompt again. Radius canvas opens also enforce the shared `radius-panel` instance ID, preventing an agent-driven reopen from creating a second panel.
