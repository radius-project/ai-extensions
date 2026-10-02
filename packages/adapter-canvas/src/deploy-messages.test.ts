import { expect, it } from "vitest";
import { DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE } from "./deploy-messages.js";

it("preserves the completed but unconfirmed deployment message", () => {
  expect(DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE).toBe(
    "GitHub reported that the deploy workflow completed, but its outcome could not be confirmed."
  );
});
