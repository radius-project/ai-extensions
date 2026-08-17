// A browser entry that reaches a Node global the way the real regression did:
// not by writing `process` itself, but by importing the `@radius-project/core`
// package barrel, which re-exports `workflows/delete.ts` and its module-scope
// `process.env.RADIUS_DELETE_REF` read.
//
// PR #395 shipped exactly this through `browser/graph/build.ts` and
// `azure-oidc.ts`, and every page failed with "process is not defined". The
// import below is deliberately the broad barrel — pointing it at a subpath
// would defeat the fixture.
import { DELETE_RADIUS_REF } from "@radius-project/core";

export function installNodeGlobal(scope: unknown): void {
  (scope as Record<string, unknown>).radiusDeleteRef = DELETE_RADIUS_REF;
}
