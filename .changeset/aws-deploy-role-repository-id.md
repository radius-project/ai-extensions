---
"radius": patch
---

**Security:** AWS deploy roles that Radius creates are now tagged with the GitHub repository ID, and setup, Repair, environment delete, and the role picker use that tag alone to decide which repository owns a role. A new repository created at a renamed repository's old name can no longer reuse that repository's deploy role. The `radius-repository` name tag stays as a readable label only.

AWS support is still behind `RADIUS_CANVAS_AWS`, so existing roles are not migrated. A role created by an earlier build has no ID tag and belongs to no repository: setup refuses it by name and accepts it only when you pick it with "use an existing role…", and delete keeps its access entry.
