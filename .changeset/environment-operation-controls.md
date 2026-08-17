---
"@radius-project/adapter-canvas": patch
---

Add durable stop, continue, rollback, and retry controls to environment setup. **Stop setup** is recorded before Radius answers, so it survives a Canvas reload: Radius finishes the Azure or GitHub step already running, records what changed, and stops before the next one, or cancels immediately while it is waiting for your answer.

A stopped setup now says **Environment setup stopped**, lists what exists, and offers two clear choices instead of one ambiguous retry. **Continue setup** resumes from the first unfinished step and names the resources it will reuse. **Roll back created resources** asks you to confirm first, showing exactly what Radius will remove, what it will keep because it reused or committed it, and what still needs you — then removes only the resources this attempt proved it created, before the workflows were committed, in reverse dependency order. Reused resources, committed workflow files, and anything Radius cannot prove it created are never removed. If a path is unavailable, Radius says why.

Every retry names the work it repeats. A continuation that fails becomes **Retry setup** with the step it stopped at, a rollback that leaves something behind becomes **Retry rollback** for just those resources, and **Retry verification** still covers a merged setup pull request or Azure role assignments that have not propagated. Duplicate clicks, lost responses, and reloads resolve to the same saved command rather than starting a second one, and a command that cannot be saved or started leaves you on the same decision with nothing changed. Every partial result names what was created, retained, reused, cleaned, and what still needs you, and deploying your application stays a separate action you start yourself.
