import { expect, type Page } from "@playwright/test";
import {
  parseSessionInfo,
  sessionIdFromAppUrl,
  type SessionInfo
} from "./journey.ts";

/**
 * Starts a new session from the New page: selects the project, sets
 * Autopilot mode, and sends the prompt. Returns the new session ID.
 */
export async function startSessionFromNewPage(
  appPage: Page,
  options: { projectName: string; prompt: string }
): Promise<string> {
  await appPage
    .getByRole("navigation", { name: "Quick links" })
    .getByRole("button", { name: "New", exact: true })
    .click();
  const main = appPage.getByRole("main");
  await expect(main.getByRole("heading", { name: "New" })).toBeVisible();

  await main.getByRole("combobox", { name: /^Project:/ }).click();
  const picker = appPage.getByRole("dialog");
  await picker
    .getByRole("combobox", { name: "Search" })
    .fill(options.projectName);
  const option = picker.getByRole("option", {
    name: options.projectName,
    exact: true
  });
  if ((await option.count()) === 0) {
    await appPage.keyboard.press("Escape");
    throw new Error(
      `Project "${options.projectName}" is not in the app project picker. Add the fixture repository as a project first.`
    );
  }
  await option.click();
  await expect(
    main.getByRole("combobox", { name: /^Project:/ })
  ).toHaveAccessibleName(new RegExp(escapeRegExp(options.projectName)));

  const modeButton = main.getByRole("button", { name: /^Mode:/ });
  await modeButton.click();
  await appPage.getByRole("menuitemradio", { name: /^Autopilot\b/ }).click();
  if (await appPage.getByRole("menu").isVisible()) {
    await appPage.keyboard.press("Escape");
  }
  await expect(modeButton).toHaveAccessibleName(/Autopilot/);

  await main.getByRole("textbox", { name: "Message" }).fill(options.prompt);
  await main.getByRole("button", { name: "Send message" }).click();
  await appPage.waitForURL(
    (url) => sessionIdFromAppUrl(url.href) !== undefined,
    {
      timeout: 120_000
    }
  );
  const sessionId = sessionIdFromAppUrl(appPage.url());
  if (!sessionId) {
    throw new Error(`The app did not open a session page: ${appPage.url()}`);
  }
  return sessionId;
}

/** Opens the session information dialog, reads it, and closes it. */
export async function readSessionInfo(appPage: Page): Promise<SessionInfo> {
  await appPage
    .getByRole("button", { name: /session information$/ })
    .first()
    .click();
  const dialog = appPage.getByRole("dialog", { name: "Session information" });
  await expect(dialog).toBeVisible();
  const labels = await dialog
    .getByRole("button")
    .evaluateAll((elements) =>
      elements.map(
        (element) =>
          element.getAttribute("aria-label") ?? element.textContent ?? ""
      )
    );
  await appPage.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  return parseSessionInfo(labels);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
