import { expect, it } from "vitest";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand
} from "./deployment-command-display.js";

it("preserves bare command presentation", () => {
  expect(
    displayGhCommand(BARE_GH_COMMAND_PRESENTATION, ["auth", "refresh"])
  ).toBe("gh auth refresh");
});

it.each(["posix", "powershell"] as const)(
  "quotes managed executable paths for %s",
  (shell) => {
    const result = displayGhCommand(
      {
        kind: "absolute",
        shell,
        executablePath: "tools/cli's gh",
        installationNote: ""
      },
      ["api", "value with space"]
    );
    expect(result).toBe(
      shell === "posix" ?
        "'tools/cli'\\''s gh' api \"value with space\""
      : "& 'tools/cli''s gh' api \"value with space\""
    );
  }
);

it("does not offer an unavailable executable", () => {
  expect(
    displayGhCommand(
      {
        kind: "unavailable",
        shell: "posix",
        installationNote: "Install the CLI."
      },
      ["auth"]
    )
  ).toBe("");
});
