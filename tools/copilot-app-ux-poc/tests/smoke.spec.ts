import { expect, test } from "../fixtures/app.ts";

// Read-only checks. Do not add clicks or typing that send prompts, start
// sessions, or change settings: these tests run against the real profile.
test.describe("Copilot app smoke (read-only)", () => {
  test("main app page is loaded", async ({ appPage }) => {
    await expect
      .poll(() => appPage.evaluate(() => document.readyState))
      .toBe("complete");
    await expect(appPage.locator("body")).toBeVisible();
    test.info().annotations.push({
      type: "app-url",
      description: appPage.url()
    });
  });

  test("a main landmark or sidebar is visible", async ({ appPage }) => {
    const shell = appPage
      .getByRole("main")
      .or(appPage.getByRole("navigation"))
      .or(appPage.getByRole("complementary"))
      .or(appPage.getByText(/^(Sessions|Chats|Projects)$/));
    await expect(shell.first()).toBeVisible();
  });

  test("full-window screenshot is attached", async ({ appPage }, testInfo) => {
    const screenshot = await appPage.screenshot({ fullPage: true });
    expect(screenshot.byteLength).toBeGreaterThan(0);
    await testInfo.attach("copilot-app-window", {
      body: screenshot,
      contentType: "image/png"
    });
  });
});
