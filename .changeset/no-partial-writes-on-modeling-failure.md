---
"radius": minor
---

Write nothing into `.radius/` when a modeling run fails.

Modeling used to write its output one file at a time — custom-type artifacts, `bicepconfig.json`, `app.bicep`, then the origin record — and `git add` them as it went. Nothing about that was transactional, so a run that failed or was cancelled partway left half an application model on disk and in the index, on top of whatever the user had before. A repository with a working model could end up with a broken one produced by a run that never finished.

A run now writes everything into `.radius/.staging-<runId>/` and a new bundled script, `promote-app-model.mjs`, moves it into `.radius/` as the last step. The staging directory sits inside `.radius/` so the publish is a rename within one filesystem, which either happens or does not, rather than a cross-filesystem copy that can fail halfway. The publish refuses unless the run holds a complete set of files, its origin record describes the application model it produced, and `.radius/app.bicep` is still the file the run started from. Because the origin record is only written after the Bicep checker passes, an application model that never compiled can never be published; and because `git add` now runs only after a successful publish, a failed run leaves nothing staged.

A hand edit made to `.radius/app.bicep` while a run is in progress is never overwritten: the publish refuses, the generated model is discarded, and the user is told their file is intact. A staging directory left behind by an interrupted run is removed at the start of the next run, and `.staging-*/` is ignored so one cannot leave untracked noise in `git status`. On any failure the run reports plainly that nothing was written, and offers a retry only when the failure looks transient — a network or registry error — rather than permanent, such as a repository with no Dockerfile.

`radius_publish_custom_type_extension` accepts the run's staging directory so its published package lands with the rest of the run. Its path confinement is unchanged, and the staging directory itself must be a `.staging-*` directory directly inside the workspace `.radius/`.
