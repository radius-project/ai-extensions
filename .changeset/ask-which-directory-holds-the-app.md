---
"radius": minor
---

Ask which directory holds the application when one cannot be identified, instead of modeling an arbitrary part of the repository.

A repository that builds several images is normally still one application, and the skill deliberately models a microservices repository into a single `Radius.Core/applications` named after the repository. So the number of Dockerfiles is not a question to put to the user, and modeling now says so explicitly rather than leaving it to inference. When several Dockerfiles are found, the authoring instructions are handed over as usual with a brief naming each candidate directory, leading with the expected outcome — model these services as one application — and noting any root workspace manifest (`pnpm-workspace.yaml`, `go.work`, and similar) as evidence the projects ship together.

The user is asked only in the two cases where no application can be identified at all: the repository holds more than one independent application that a single definition cannot represent, or nothing in it is an application and the Dockerfiles build only tooling or CI images. That judgment needs the source read, so it stays with the agent; the assembly layer owns the mechanical half — the candidate directories, the workspace-manifest signal, and the single copy of the question — so the two cannot drift. In those cases nothing is written: no `app.bicep`, no `bicepconfig.json`, no origin record. The user answers with a directory and asks for analysis again, which scopes the next run to it through the existing subdirectory support in `build.source`.

A listing that could not be established is still never reported as a repository with no application.
