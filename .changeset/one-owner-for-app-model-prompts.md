---
"radius": patch
---

Stop prompting twice to author `.radius/app.bicep`. The pre-tool-use hook no longer intercepts `radius_generate_pr_diff_markdown`: that tool compares the models committed on two named refs, while modeling only ever writes the working tree, so denying the call and handing off to the `radius-app-bicep` skill could not put a model on either ref and simply raised a second authoring turn in the middle of pull request creation. The tool now runs and reports its own outcome, and the pull request guard turns a missing model on both branches into "create the pull request without a graph diff section" as it already does for every other unavailable diff. Opening a graph canvas page remains the single trigger for authoring a model.
