import { describe, expect, it } from "vitest";
import {
  displayGhCommand,
  displayGhCommands,
  GH_SYSTEM_INSTALL_ALTERNATIVE,
  parseGhCommandPresentation,
  presentedRemediationView,
  presentRemediation
} from "./gh-command-display.js";
import { buildRemediation } from "@radius-project/core/remediations";

describe("GitHub CLI command display", () => {
  it("preserves the short command when gh is on the terminal PATH", () => {
    expect(
      displayGhCommand(
        { kind: "bare", shell: "powershell", installationNote: "" },
        ["auth", "refresh", "-h", "github.com", "-s", "workflow"]
      )
    ).toBe("gh auth refresh -h github.com -s workflow");
  });

  it("renders a PowerShell call for a bundled Windows path", () => {
    expect(
      displayGhCommand(
        {
          kind: "absolute",
          shell: "powershell",
          executablePath: "C:\\Users\\Taylor O'Brien\\copilot\\gh.exe",
          installationNote: GH_SYSTEM_INSTALL_ALTERNATIVE
        },
        ["auth", "refresh", "-h", "github.com", "-s", "two words"]
      )
    ).toBe(
      "& 'C:\\Users\\Taylor O''Brien\\copilot\\gh.exe' auth refresh -h github.com -s \"two words\""
    );
  });

  it.each([
    [
      "zsh",
      "/Users/taylor's tools/copilot/gh",
      "'/Users/taylor'\\''s tools/copilot/gh' auth login"
    ],
    [
      "Bash",
      "/home/taylor/My Tools/copilot/gh",
      "'/home/taylor/My Tools/copilot/gh' auth login"
    ]
  ])(
    "renders a safely quoted %s invocation",
    (_shell, executablePath, expected) => {
      expect(
        displayGhCommand(
          {
            kind: "absolute",
            shell: "posix",
            executablePath,
            installationNote: GH_SYSTEM_INSTALL_ALTERNATIVE
          },
          ["auth", "login"]
        )
      ).toBe(expected);
    }
  );

  it("returns no command when GitHub CLI is unavailable", () => {
    expect(
      displayGhCommand(
        {
          kind: "unavailable",
          shell: "posix",
          installationNote: "Install GitHub CLI."
        },
        ["auth", "login"]
      )
    ).toBe("");
  });

  it("renders every gh command in a sequence without changing other executables", () => {
    expect(
      displayGhCommands(
        {
          kind: "absolute",
          shell: "posix",
          executablePath: "/opt/Copilot CLI/gh",
          installationNote: GH_SYSTEM_INSTALL_ALTERNATIVE
        },
        [
          ["gh", "auth", "switch", "-u", "octocat"],
          ["git", "status"],
          ["gh", "auth", "refresh", "-s", "workflow"]
        ]
      )
    ).toBe(
      "'/opt/Copilot CLI/gh' auth switch -u octocat\ngit status\n'/opt/Copilot CLI/gh' auth refresh -s workflow"
    );
  });

  it("adapts GitHub remediation display without changing its execution argv", () => {
    const result = buildRemediation("github-workflow-scope", {});
    if (!result.ok) throw new Error(result.reason);

    const presented = presentRemediation(result.remediation, {
      kind: "absolute",
      shell: "posix",
      executablePath: "/opt/copilot/gh",
      installationNote: GH_SYSTEM_INSTALL_ALTERNATIVE
    });

    expect(presented.displayCommand).toBe(
      "'/opt/copilot/gh' auth refresh -h github.com -s workflow"
    );
    expect(presented.argv).toBe(result.remediation.argv);
  });

  it("returns a non-GitHub remediation unchanged", () => {
    const result = buildRemediation("aws-cli-login", {});
    if (!result.ok) throw new Error(result.reason);

    expect(
      presentRemediation(result.remediation, {
        kind: "unavailable",
        shell: "posix",
        installationNote: "Install GitHub CLI."
      })
    ).toBe(result.remediation);
  });

  it("keeps a clear fallback command when GitHub CLI is unavailable", () => {
    const result = buildRemediation("github-workflow-scope", {});
    if (!result.ok) throw new Error(result.reason);

    expect(
      presentRemediation(result.remediation, {
        kind: "unavailable",
        shell: "posix",
        installationNote: "Install GitHub CLI."
      })
    ).toBe(result.remediation);
  });

  it("adds the install alternative to a bundled remediation view", () => {
    const view = presentedRemediationView(
      "github-account-scopes",
      { login: "octocat", workflow: "true" },
      {
        kind: "absolute",
        shell: "powershell",
        executablePath: "C:\\Copilot Tools\\gh.exe",
        installationNote: GH_SYSTEM_INSTALL_ALTERNATIVE
      }
    );

    expect(view.command).toContain("& 'C:\\Copilot Tools\\gh.exe' auth switch");
    expect(view.warning).toContain(GH_SYSTEM_INSTALL_ALTERNATIVE);
  });

  it("disables a GitHub remediation when no executable is available", () => {
    const view = presentedRemediationView(
      "github-workflow-scope",
      {},
      {
        kind: "unavailable",
        shell: "posix",
        installationNote: "Install GitHub CLI."
      }
    );

    expect(view).toMatchObject({
      command: "",
      runnable: false,
      unsupportedReason: "Install GitHub CLI.",
      warning: ""
    });
  });

  it("does not alter non-GitHub remediations or invalid requests", () => {
    const presentation = {
      kind: "unavailable",
      shell: "posix",
      installationNote: "Install GitHub CLI."
    } as const;

    expect(
      presentedRemediationView("azure-cli-login", {}, presentation)
    ).toEqual(
      presentedRemediationView(
        "azure-cli-login",
        {},
        { kind: "bare", shell: "posix", installationNote: "" }
      )
    );
    expect(presentedRemediationView("unknown", {}, presentation).runnable).toBe(
      false
    );
  });

  it("parses valid serialized presentations and rejects malformed values", () => {
    expect(
      parseGhCommandPresentation({
        kind: "absolute",
        shell: "powershell",
        executablePath: "C:\\Copilot\\gh.exe",
        installationNote: "Install GitHub CLI."
      })
    ).toEqual({
      kind: "absolute",
      shell: "powershell",
      executablePath: "C:\\Copilot\\gh.exe",
      installationNote: "Install GitHub CLI."
    });
    expect(
      parseGhCommandPresentation({
        kind: "unavailable",
        shell: "posix",
        installationNote: "Install GitHub CLI."
      })
    ).toEqual({
      kind: "unavailable",
      shell: "posix",
      installationNote: "Install GitHub CLI."
    });
    expect(
      parseGhCommandPresentation({
        kind: "bare",
        shell: "powershell",
        installationNote: "ignored"
      })
    ).toEqual({
      kind: "bare",
      shell: "powershell",
      installationNote: ""
    });
    for (const value of [
      null,
      [],
      { kind: "absolute", shell: "fish", executablePath: "/gh" },
      { kind: "absolute", shell: "posix", executablePath: "" },
      { kind: "absolute", shell: "posix", executablePath: "/gh" },
      { kind: "unavailable", shell: "posix", installationNote: "" }
    ]) {
      expect(parseGhCommandPresentation(value).kind).toBe("bare");
    }
  });
});
