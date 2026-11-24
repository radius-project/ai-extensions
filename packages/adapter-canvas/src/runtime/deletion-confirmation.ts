import type { SessionHolder } from "./session.js";

export async function confirmDeletion(
  holder: SessionHolder,
  message: string,
  isActive: () => boolean
): Promise<boolean | undefined> {
  if (!isActive()) return undefined;
  const session = holder.tryGet();
  const ui = session?.ui;
  if (session?.capabilities?.ui?.elicitation !== true || !ui?.confirm) {
    return undefined;
  }
  let confirmed: boolean;
  try {
    confirmed = await ui.confirm(message);
  } catch {
    return undefined;
  }
  if (!isActive() || holder.tryGet() !== session) return undefined;
  return confirmed === true;
}
