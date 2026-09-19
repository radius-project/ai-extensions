import { describe, expect, it } from "vitest";
import { cloudCredentialsComplete } from "./provider-credentials.js";

describe("supported provider credential completeness", () => {
  it.each([
    ["azure", {}, false],
    ["azure", { clientId: "application", tenantId: "tenant" }, false],
    ["azure", { tenantId: "tenant", subscriptionId: "subscription" }, false],
    [
      "azure",
      { clientId: "application", subscriptionId: "subscription" },
      false
    ],
    [
      "azure",
      {
        clientId: "application",
        tenantId: "tenant",
        subscriptionId: "subscription"
      },
      true
    ],
    ["aws", {}, false],
    ["aws", { roleArn: "synthetic-role" }, true]
  ] as const)(
    "validates %s credentials %j",
    (provider, credentials, complete) => {
      expect(cloudCredentialsComplete(provider, credentials)).toBe(complete);
    }
  );
});
