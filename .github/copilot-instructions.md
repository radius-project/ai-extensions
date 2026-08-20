# Copilot instructions for this repository

## This repository is not a Radius application

This repository holds the source of the Radius Copilot plugin itself — the canvas extension, the skills, and their tests. It is a TypeScript monorepo, not a containerized application: it has no `Dockerfile` and no `.radius/app.bicep`, and it is not modeled or deployed as a Radius application.

Contributors here usually have the Radius plugin installed so they can exercise the extension they are developing. Its session instructions are written for a repository that *is* a Radius application, so the parts of them that ask for an application model do not apply here.

Therefore, when working in this repository:

- **Do not attach an application graph diff to a pull request.** Skip the `radius_generate_pr_diff_markdown` step rather than calling it — there is no application model here for it to diff. (The plugin instructs the agent to leave the section out when no diff comes back; skipping the call avoids the pointless round trip.)
- **Do not author `.radius/app.bicep`, a Dockerfile, or any other application model** to make the graph work. Fixtures and test data that contain such files exist to exercise the extension's own behavior and do not describe this repository.
- **Do not open the Radius canvas graph, planned, or graph-diff pages against this repository.** To exercise those views, point the canvas at a separate repository that has a real application model.

These restrictions are scoped to this repository and say nothing about how the plugin should behave anywhere else.
