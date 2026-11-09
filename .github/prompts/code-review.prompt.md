---
mode: agent
description: "Review a pull request or the current branch using the canonical radius-code-review skill."
---

# Review a Pull Request

Use the `radius-code-review` skill to review `${input:pr:PR number or URL (leave blank for the current branch)}` in the `ai-extensions` repository. Pass the resolved input as the PR target; if it is blank, review the current branch against its base as directed by the skill.

Invoke the skill when available. Otherwise, read and follow [the canonical skill instructions](../skills/radius-code-review/SKILL.md). The skill is the source of truth for the review workflow, output format, and publication permissions.

This prompt remains usable in clients that support prompt files. In Copilot CLI or the Copilot app, you can invoke the skill directly with `Use the /radius-code-review skill to review PR 123` or `Use the /radius-code-review skill to review the current branch`.
