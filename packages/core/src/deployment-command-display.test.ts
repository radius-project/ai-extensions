import { expect, it } from "vitest";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  displayShellCommand
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
        "'tools/cli'\\''s gh' api 'value with space'"
      : "& 'tools/cli''s gh' api 'value with space'"
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

it("refuses batch expansions instead of offering a misleading runnable command", () => {
  for (const executable of ["gh.cmd", "gh.BAT"])
    expect(() =>
      displayShellCommand("powershell", executable, ["%PATH%"])
    ).toThrow("Windows batch executable");
  expect(displayShellCommand("powershell", "gh.cmd", ["two words"])).toBe(
    "gh.cmd 'two words'"
  );
  expect(displayShellCommand("posix", "gh.cmd", ["%PATH%"])).toBe(
    "gh.cmd '%PATH%'"
  );
});

it.each(["posix", "powershell"] as const)(
  "quotes expansion and statement syntax literally in %s",
  (shell) => {
    for (const token of [
      "$HOME",
      "`whoami`",
      "; echo",
      "%PATH%",
      "a|b",
      "a&b",
      "a>b",
      "a<b",
      "#comment",
      "tab\tvalue",
      "line\nvalue"
    ]) {
      expect(displayShellCommand(shell, "git", [token])).toBe(`git '${token}'`);
    }
    expect(displayShellCommand(shell, "tool's path", ["it's"])).toBe(
      shell === "posix" ?
        "'tool'\\''s path' 'it'\\''s'"
      : "& 'tool''s path' 'it''s'"
    );
  }
);

it("preserves empty arguments and literal quotes in POSIX guidance", () => {
  expect(displayShellCommand("posix", "gh", ["", '.["field name"]'])).toBe(
    "gh '' '.[\"field name\"]'"
  );
});

it("scopes native Legacy marshalling for PowerShell empty and quoted arguments", () => {
  expect(
    displayShellCommand("powershell", "gh", [
      "",
      '.["field name"]',
      "two words\\",
      'a\\"b'
    ])
  ).toBe(
    '& { $PSNativeCommandArgumentPassing = \'Legacy\'; gh \'""\' \'".[""field name""]"\' \'"two words\\\\"\' \'"a\\\\""b"\' }'
  );
});

it("quotes PowerShell splats and marshals whitespace with a trailing slash", () => {
  expect(displayShellCommand("powershell", "gh", ["@value"])).toBe(
    "gh '@value'"
  );
  expect(displayShellCommand("posix", "gh", ["@value"])).toBe("gh @value");
  expect(displayShellCommand("powershell", "gh", [",start"])).toBe(
    "gh ',start'"
  );
  expect(displayShellCommand("powershell", "gh", ["two words\\"])).toBe(
    "& { $PSNativeCommandArgumentPassing = 'Legacy'; gh '\"two words\\\\\"' }"
  );
});

it.each([
  ["", []],
  ["gh", ["\0"]],
  ["g\0h", []]
] as const)("refuses an unrepresentable command %j", (executable, args) => {
  expect(() => displayShellCommand("posix", executable, args)).toThrow(
    "Cannot display"
  );
});
