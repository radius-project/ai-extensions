import type { GitHubAccountSelectionPorts } from "@radius-project/core";
import type { SessionPort } from "./session.js";

export function githubAccountChoice(
  session: Pick<SessionPort, "capabilities" | "ui"> | undefined
): GitHubAccountSelectionPorts["choose"] {
  if (session?.capabilities?.ui?.elicitation !== true) return undefined;
  const ui = session.ui;
  if (!ui) return undefined;
  return ({ target, logins }) =>
    ui.select(
      `Choose the GitHub account for ${target.repo}, environment ${target.environment}. Radius will recheck its access before starting work.`,
      [...logins]
    );
}
