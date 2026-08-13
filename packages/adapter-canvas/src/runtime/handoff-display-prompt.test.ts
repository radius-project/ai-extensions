// Anti-regression guard for issue #209.
//
// Every machine-authored turn this extension injects with session.send occupies
// the user lane in the chat timeline. session.log cannot replace it: only a sent
// turn drives agent work. So the invariant is that each such send carries a
// displayPrompt, which is what keeps a long internal instruction from rendering
// as if the user typed and submitted it.
//
// The paired builders (appBicepHandoffMessage / deployRepairHandoffMessage /
// azureCliAssistMessage) make that automatic, and their behavior is asserted in
// hooks.test.ts, create-radius-extension.test.ts, and server.test.ts. These
// checks exist for the failure those tests cannot see: someone bypassing a
// builder and going back to session.send(<prompt string>). A source scan is the
// only way to catch a call site that no longer exists in the wiring.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sources = {
  "create-radius-canvas.ts": readFileSync(
    new URL("./create-radius-canvas.ts", import.meta.url),
    "utf8"
  ),
  "create-radius-extension.ts": readFileSync(
    new URL("./create-radius-extension.ts", import.meta.url),
    "utf8"
  ),
  "server.ts": readFileSync(new URL("../server.ts", import.meta.url), "utf8")
};

// The agent-facing halves. Passing one of these directly to session.send (or to
// a session-prompt handler) is exactly the #209 regression.
const AGENT_PROMPT_BUILDERS = [
  "appBicepHandoffPrompt",
  "deployRepairHandoffPrompt",
  "buildAzureCliAssistPrompt"
];

describe("issue #209: automated turns never render as user-authored messages", () => {
  it("never passes an agent-facing prompt builder straight into a sent turn", () => {
    for (const [file, source] of Object.entries(sources)) {
      for (const builder of AGENT_PROMPT_BUILDERS) {
        // e.g. `session.send(appBicepHandoffPrompt(` or
        // `invokeSessionPrompt(handler, buildAzureCliAssistPrompt(`
        expect(
          source,
          `${file} must send ${builder} through its paired *Message builder`
        ).not.toMatch(
          new RegExp(`(?:send|invokeSessionPrompt)\\([^)]*\\b${builder}\\(`)
        );
      }
    }
  });

  it("routes every handoff through a builder that pairs prompt with displayPrompt", () => {
    expect(sources["create-radius-canvas.ts"]).toContain(
      "send(appBicepHandoffMessage("
    );
    expect(sources["create-radius-extension.ts"]).toContain(
      "send(appBicepHandoffMessage("
    );
    expect(sources["create-radius-extension.ts"]).toContain(
      "deployRepairHandoffMessage("
    );
    expect(sources["server.ts"]).toContain("azureCliAssistMessage(");
  });
});
