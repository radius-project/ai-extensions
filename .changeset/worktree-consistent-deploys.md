---
"radius": patch
---

Document issue #274's environment-creation behavior: the flow now verifies Entra ownership before reusing an app, applies and verifies Radius provenance tags, reuses any user-owned app, never reclaims an unowned tagged app, runs GHCR write preflight before Azure mutation, and keeps rollback bounded to the current operation. Before the commit point, Azure artifacts created by the current attempt are rolled back, committed workflow files are retained as reusable artifacts, and a GitHub Environment seen only through a pre-create 404 is left in place for manual cleanup because GitHub's idempotent PUT cannot prove this request created it. After the commit point, later verification failures retain the committed workflows and GHCR package instead of rewinding setup.
