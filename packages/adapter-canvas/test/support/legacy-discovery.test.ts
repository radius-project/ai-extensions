import { expect, it } from "vitest";
import { createLegacyDiscoveryFake } from "./legacy-discovery.js";

it("throws on unmodeled canonical evidence instead of inventing fixture rows", async () => {
  const opened = await createLegacyDiscoveryFake().open("owner/repo", "panel");
  if (opened.status !== "ok") throw new Error("Expected fixture");
  await expect(opened.value.applications("feature")).rejects.toThrow(
    "Unmodeled"
  );
  await expect(opened.value.environments()).rejects.toThrow("Unmodeled");
  expect(await opened.value.run(["api", "/repos/owner/repo"])).toEqual({
    ok: false,
    stdout: ""
  });
  await opened.value.close();
});
it("provides only explicitly scripted application and environment observations", async () => {
  const opened = await createLegacyDiscoveryFake({
    application: async (_repo, branch) => {
      expect(branch).toBe("feature");
      return "app";
    },
    cli: (_command, args, _options, callback) => {
      const path = args.find((arg) => arg.startsWith("/repos/"));
      if (path?.includes("/variables"))
        callback(null, "RADIUS_MANAGED\ttrue\nAZURE_CLIENT_ID\tclient", "");
      else if (path?.includes("/environments?")) callback(null, "1\tdev", "");
      else throw new Error("Unmodeled fixture command");
      return undefined;
    }
  }).open("owner/repo", "panel");
  if (opened.status !== "ok") throw new Error("Expected fixture");
  expect(await opened.value.applications("feature")).toMatchObject({
    status: "ok",
    value: { items: [{ target: { application: "app" } }] }
  });
  expect(await opened.value.environments()).toMatchObject({
    status: "ok",
    value: {
      entries: [
        {
          inspection: { configuration: { provider: "azure" } },
          metadata: { id: "1" }
        }
      ]
    }
  });
  await opened.value.close();
});
