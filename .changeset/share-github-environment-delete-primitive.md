---
"radius": patch
---

Extract the idempotent GitHub-environment delete into the shared `server/services/github-environment.ts` module so the Delete Environment flow and Create-Environment rollback share one cleanup primitive instead of duplicating it. The delete flow (via `server.ts`) now binds its `gh` runner and environment-list cache to `deleteGitHubEnvironmentIdempotent(repo, env, ports)`; a future rollback runner binds its own ports to the same function, guaranteeing both flows classify a 404 as `not_found` and invalidate the env-list cache identically. Behavior is unchanged; this only removes the impending duplication called out in the shared-cleanup design note.
