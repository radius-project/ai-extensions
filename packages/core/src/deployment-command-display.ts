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

function quoteLiteral(value: string, shell: "powershell" | "posix"): string {
  return `'${value.replaceAll("'", shell === "powershell" ? "''" : "'\\''")}'`;
}

/** Formats display guidance only; process execution must continue to use argv. */
export function displayShellCommand(
  shell: "powershell" | "posix",
  executable: string,
  args: readonly string[],
  absolute = false
): string {
  if (
    !executable ||
    [executable, ...args].some((value) => value.includes("\0"))
  )
    throw new Error(
      "Cannot display an empty executable or a NUL-containing argument."
    );
  if (
    shell === "powershell" &&
    /\.(?:cmd|bat)$/i.test(executable) &&
    args.some((value) => /[%!^&|<>"\r\n]/.test(value))
  )
    throw new Error(
      "Cannot safely display these arguments for a Windows batch executable; use a native CLI executable."
    );
  const safe = (value: string): boolean =>
    /^[A-Za-z0-9_./:@=,+-]+$/.test(value) &&
    !(shell === "powershell" && /^[@,]/.test(value));
  const invocation =
    absolute || !safe(executable) ?
      `${shell === "powershell" ? "& " : ""}${quoteLiteral(executable, shell)}`
    : executable;
  const legacy =
    shell === "powershell" &&
    args.some(
      (value) =>
        value === "" ||
        value.includes('"') ||
        (/\s/.test(value) && value.endsWith("\\"))
    );
  const tokens = args.map((value) => {
    if (safe(value)) return value;
    if (!legacy) return quoteLiteral(value, shell);
    // PowerShell 5.1's native marshaller consumes a quote layer. Doubling quotes
    // (not backslash-escaping them) preserves embedded quotes with whitespace.
    const encoded = value.replace(/\\+|"/g, (run, offset: number) => {
      if (run === '"') return '""';
      return (
          offset + run.length === value.length ||
            value[offset + run.length] === '"'
        ) ?
          run + run
        : run;
    });
    return quoteLiteral(`"${encoded}"`, shell);
  });
  const command = [invocation, ...tokens].join(" ");
  // Match 5.1 on 7 as well, scoped so copying a command cannot change the user's
  // argument-passing preference for later commands.
  return legacy ?
      `& { $PSNativeCommandArgumentPassing = 'Legacy'; ${command} }`
    : command;
}

/** Display only: execution continues to use argv, never this shell string. */
export function displayGhCommand(
  presentation: GhCommandPresentation,
  args: readonly string[]
): string {
  if (presentation.kind === "unavailable") return "";
  return displayShellCommand(
    presentation.shell,
    presentation.kind === "absolute" ? presentation.executablePath : "gh",
    args,
    presentation.kind === "absolute"
  );
}
