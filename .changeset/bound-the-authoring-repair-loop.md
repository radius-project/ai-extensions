---
"radius": patch
---

Bound the repair loop that runs while an application definition is being authored, so a model that will not compile ends in a reported error rather than in an agent editing until it runs out of context.

The skill already required compiling the generated `app.bicep` and repairing every error and warning until the checker passed, but that loop had no attempt limit and no defined way to give up. The rule that does say when to stop only covered the repair path driven by a failed deploy, not authoring.

Authoring now gets the same treatment: at most three repair passes, matching the budget the deploy repair loop already uses; a requirement to make a materially different fix when the same compiler error comes back, rather than varying one that has already failed; and a stop that reports which resource and property the compiler rejected, quotes the compiler output, and writes no application definition. A compile error the skill cannot resolve is usually a real signal, such as a schema that has moved or a type the configured extension does not have, so handing it to the user is more useful than another attempt.
