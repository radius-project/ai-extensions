---
"radius": patch
---

Bound the repair loop that runs while an application definition is being authored, so a model that will not compile ends in a reported error rather than in an agent editing until it runs out of context.

The skill already required compiling the generated `app.bicep` and repairing every error and warning until the checker passed, but that loop had no attempt limit and no defined way to give up. The rule that does say when to stop only covered the repair path driven by a failed deploy, not authoring.

`validate-bicep.mjs` now enforces the bound itself rather than asking for it in prose. When the model it compiles is inside a staged modeling run, it counts its own runs in that run's `run.json`: it refuses to compile a fourth time and says the budget is spent, and it fingerprints the compiler output — with line numbers and diagnostic ordering normalized out — so it can tell the agent when a failure is the one it just saw and the last fix was therefore wrong. The count lives in the run record, so it covers exactly one modeling run and a later run starts fresh. Compiling a file outside a staged run, such as `.radius/app.bicep` directly, has no budget and is unchanged.

The budget is three compiles, matching the budget the deploy repair loop already uses. What remains in the skill is the part the script cannot do: report which resource and property the compiler rejected, quote the last compiler output verbatim, and write no application definition. A compile error the skill cannot resolve is usually a real signal, such as a schema that has moved or a type the configured extension does not have, so handing it to the user is more useful than another attempt.
