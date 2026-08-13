---
description: 'Mandatory architecture, testing, coverage, TypeScript, JavaScript, and Vitest rules for repository code changes'
applyTo: '**/*.{ts,tsx,js,jsx,mjs,cjs}'
---

# Code quality requirements

Before adding, editing, refactoring, or reviewing TypeScript or JavaScript, use the [`radius-code-quality`](../skills/radius-code-quality/SKILL.md) skill and follow its complete workflow. When reviewing rather than implementing, verify the change against the skill instead of running the implementation workflow.

When a change modifies production TypeScript or JavaScript, it must include meaningful collocated unit tests, target 100% line, statement, function, and branch coverage for new and changed code, avoid regressing repository coverage, and add the boundary or scenario tests the changed seam requires. Treat 100% as a quality goal rather than forcing it through test-only production hooks, artificial unreachable states, excessive implementation mocking, or assertions written only to execute lines; prefer natural, behavior-focused tests and document legitimate limitations. Production design must follow the repository's package boundaries and architecture.

The Radius Canvas testability work is delivered in phases, so some areas have no testable seam yet. Do not force a test that the current structure cannot support honestly: check the phase status in `docs/design/2026-08-radius-canvas-test-plan.md`, add the strongest test the code genuinely supports, and name the unavailable layer as an explicit gap instead of manufacturing testability with broad module mocks, private reach-through, or source-substring assertions. Safety, branch-selection, path-confinement, external-error, and destructive-operation behavior is never deferred on these grounds.

Build scripts, configuration, and workflow generators are verified by artifact, configuration, or command-level checks rather than a forced unit test. Generated output such as `plugins/radius/dist/` is never hand-edited or tested directly; rebuild it from source and confirm it is in sync.
