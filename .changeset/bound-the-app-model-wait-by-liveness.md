---
"radius": patch
---

Stop cutting off a live modeling run, and let every graph page recover once the model lands.

While Copilot authors `.radius/app.bicep`, a graph request answers `needsAppBicep` instead of failing, and the page keeps asking. That wait was bounded by a flat five-minute wall clock, which was long enough only because the application-model prompt used to run before the panel opened. Now that the panel opens first, the clock covers the authoring itself, and modeling a real multi-service repository routinely outlasts it — so the Modeled tab reported that Copilot "may be unable to model this repository" and stopped, in the middle of a run that was working.

The budget is now spent only on inactivity. A modeling run creates `.radius/.staging-<runId>/` before it writes anything and updates that directory or its staged artifacts while it works. The newest modification time separates "still working" from an abandoned staging directory left behind by a cancelled or crashed run. A wait expires after five idle minutes and is capped at thirty minutes overall so a continuously active but wedged run cannot renew forever. The three outcomes now read differently: a run that never appeared, a run that started and stopped without publishing a model, and a run that exceeded the ceiling.

The expiry decision moved to the server, into the single place every graph route's `needsAppBicep` answer passes through. An expired wait arrives as an ordinary error, so no page needs its own clock.

The Planned and Diff tabs also kept their part of the bargain for the first time. Both announced "Copilot is generating .radius/app.bicep…" once and then never asked again, so neither recovered even after the model was written — the panel simply sat there until the user reloaded. Both now retry until the model lands or the server ends the wait.
