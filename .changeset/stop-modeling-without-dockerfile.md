---
"radius": patch
---

Stop application modeling when the repository contains no Dockerfile, instead of proceeding into an ambiguous failure. The requirement previously existed only as prompt text the agent was asked to honor; it is now enforced. `radius_generate_app` inspects the repository's file listing and returns the unsupported-configuration message in place of the authoring instructions when nothing containerized is there to model, and the graph views that auto-trigger modeling deny with the same message rather than telling the agent to create a model it cannot create. The check covers the current worktree branch and any other branch, ignores Dockerfiles inside vendored or generated directories such as `node_modules`, and treats a file listing it could not read as unknown rather than reporting the repository as unsupported.
