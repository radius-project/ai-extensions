import {
  buildRemediation,
  remediationView
} from "@radius-project/core/remediations";
import type {
  Remediation,
  RemediationView
} from "@radius-project/core/remediations";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  displayShellCommand,
  type GhCommandPresentation
} from "@radius-project/core/deployment-command-display";
export {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "@radius-project/core/deployment-command-display";

export type GhCommandShell = "powershell" | "posix";

export const GH_SYSTEM_INSTALL_ALTERNATIVE =
  "Alternatively, install GitHub CLI system-wide so `gh` is available on your terminal PATH.";
export function parseGhCommandPresentation(
  value: unknown
): GhCommandPresentation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return BARE_GH_COMMAND_PRESENTATION;
  }
  const record = value as Record<string, unknown>;
  const shell =
    record.shell === "powershell" || record.shell === "posix" ?
      record.shell
    : null;
  if (!shell) return BARE_GH_COMMAND_PRESENTATION;
  if (record.kind === "bare") {
    return { kind: "bare", shell, installationNote: "" };
  }
  if (
    record.kind === "absolute" &&
    typeof record.executablePath === "string" &&
    record.executablePath !== "" &&
    typeof record.installationNote === "string"
  ) {
    return {
      kind: "absolute",
      shell,
      executablePath: record.executablePath,
      installationNote: record.installationNote
    };
  }
  if (
    record.kind === "unavailable" &&
    typeof record.installationNote === "string" &&
    record.installationNote !== ""
  ) {
    return {
      kind: "unavailable",
      shell,
      installationNote: record.installationNote
    };
  }
  return BARE_GH_COMMAND_PRESENTATION;
}

export function displayGhCommands(
  presentation: GhCommandPresentation,
  commands: readonly (readonly string[])[]
): string {
  return commands
    .map((command) => {
      const [executable, ...args] = command;
      return executable === "gh" ?
          displayGhCommand(presentation, args)
        : displayShellCommand(presentation.shell, executable, args);
    })
    .join("\n");
}

export function presentRemediation(
  remediation: Remediation,
  presentation: GhCommandPresentation
): Remediation {
  if (
    presentation.kind === "unavailable" ||
    !remediation.argv.some(([executable]) => executable === "gh")
  ) {
    return remediation;
  }
  return {
    ...remediation,
    displayCommand: displayGhCommands(presentation, remediation.argv)
  };
}

export function presentedRemediationView(
  id: unknown,
  params: unknown,
  presentation: GhCommandPresentation
): RemediationView {
  const view = remediationView(id, params);
  const result = buildRemediation(id, params);
  if (!result.ok || !result.remediation.argv.some(([name]) => name === "gh")) {
    return view;
  }
  if (presentation.kind === "unavailable") {
    return {
      ...view,
      command: "",
      runnable: false,
      unsupportedReason: presentation.installationNote,
      warning: ""
    };
  }
  return {
    ...view,
    command: displayGhCommands(presentation, result.remediation.argv),
    warning: [view.warning, presentation.installationNote]
      .filter((message) => message !== "")
      .join(" ")
  };
}
