export type GhCommandPresentation =
  | {
      readonly kind: "bare";
      readonly shell: "powershell" | "posix";
      readonly installationNote: "";
    }
  | {
      readonly kind: "absolute";
      readonly shell: "powershell" | "posix";
      readonly executablePath: string;
      readonly installationNote: string;
    }
  | {
      readonly kind: "unavailable";
      readonly shell: "powershell" | "posix";
      readonly installationNote: string;
    };

export const BARE_GH_COMMAND_PRESENTATION: GhCommandPresentation = {
  kind: "bare",
  shell: "posix",
  installationNote: ""
};

/** Display only: execution continues to use argv, never this shell string. */
export function displayGhCommand(
  presentation: GhCommandPresentation,
  args: readonly string[]
): string {
  if (presentation.kind === "unavailable") return "";
  let executable = "gh";
  if (presentation.kind === "absolute") {
    executable =
      presentation.shell === "powershell" ?
        `& '${presentation.executablePath.replaceAll("'", "''")}'`
      : `'${presentation.executablePath.replaceAll("'", "'\\''")}'`;
  }
  return [
    executable,
    ...args.map((token) => (token.includes(" ") ? `"${token}"` : token))
  ].join(" ");
}
