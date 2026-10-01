import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

// The workspace is an ancestor of this scratch consumer. Fail rather than
// silently satisfying a missing installed dependency from workspace modules.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.startsWith("file:")) {
      const path = relative(root, fileURLToPath(resolved.url));
      assert.ok(
        !path.startsWith("..") && !isAbsolute(path),
        `Workspace import leaked into packed consumer: ${resolved.url}`
      );
    }
    return resolved;
  }
});
