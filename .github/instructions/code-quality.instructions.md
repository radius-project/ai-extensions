---
description: 'Mandatory architecture, testing, coverage, TypeScript, JavaScript, and Vitest rules for repository code changes'
applyTo: '**/*.{ts,tsx,js,jsx,mjs,cjs}'
---

# Code quality requirements

Before adding, editing, refactoring, or reviewing TypeScript or JavaScript, use the [`radius-code-quality`](../skills/radius-code-quality/SKILL.md) skill and follow its complete workflow.

When a change modifies production TypeScript or JavaScript, it must include meaningful collocated unit tests, target 100% line, statement, function, and branch coverage for new and changed code, preserve the repository coverage baseline, and add every boundary or scenario test required by the Radius Canvas test architecture and test plan in PR #282. Treat 100% as a quality goal rather than forcing it through test-only production hooks, artificial unreachable states, excessive implementation mocking, or assertions written only to execute lines; prefer natural, behavior-focused tests and document legitimate limitations. Production design must follow the package boundaries and re-architecture defined by those documents.
