---
"radius": patch
---

Keep an unavailable application graph diff out of pull request descriptions. The session-start instruction told the agent to generate a graph diff for every pull request and put it at the top of the description, with no branch for the case where there is no diff to put there. In a repository with no application model on the compared branches the call is denied, and the agent — still holding an instruction to include something — wrote the denial into the pull request body as a sentence explaining that the graph diff was unavailable for want of a Dockerfile or `app.bicep`. That reads as a fact about the change under review when it is only a fact about the repository state, and it affects any repository with the plugin installed and no model yet, including the window between installing the plugin and modeling an application.

Including the section is now conditional on a diff actually coming back. When one does not — the call is denied, the repository has no application to model, the compared branches carry no committed `.radius/app.bicep`, or the tool fails — the section is left out entirely, the reason is reported in the session where the user can act on it, and the graph-diff canvas page is not opened. The `radius_generate_pr_diff_markdown` description carries the same condition, so the instruction the agent reads at the call site no longer asks unconditionally for the result to be embedded.

The omission is scoped to the graph diff section rather than to the subject: a pull request that does change Radius modeling is still described normally.
