import { describe, expect, it } from "vitest";
import { parseLegacyResourceId } from "./legacy-resource-id.js";

const prefix = "/planes/radius/Local/resourceGroups/Demo/providers/";

describe("legacy Radius navigation identity projection", () => {
  it("preserves values and accepts legal digits, dots and underscores", () => {
    expect(
      parseLegacyResourceId(prefix + "Applications.Core/containers/web_1.2")
    ).toEqual({
      plane: "Local",
      group: "Demo",
      type: "Applications.Core/containers",
      name: "web_1.2"
    });
    expect(
      parseLegacyResourceId(
        (prefix + "Radius.Core/applications/App")
          .replace("/planes/radius/", "/PLANES/RADIUS/")
          .replace("/resourceGroups/", "/RESOURCEGROUPS/")
      )
    ).toEqual({
      plane: "Local",
      group: "Demo",
      type: "Radius.Core/applications",
      name: "App"
    });
  });
  it.each([
    "invalid",
    prefix + "Applications.Core/containers/web/children/nested",
    "/subscriptions/sub/resourceGroups/Demo/providers/Applications.Core/containers/web",
    "/planes/aws/aws/accounts/123/regions/west/providers/AWS.Service/widgets/name",
    "/planes/radius/Local/providers/Applications.Core/containers/web",
    "/planes/radius/Local/global/global/providers/Applications.Core/containers/web",
    "/planes/radius/Local/other/x/resourceGroups/Demo/providers/Applications.Core/containers/web",
    prefix + "Applications.Core/containers/..",
    prefix + "Applications.Core/containers/web?query=true"
  ])(
    "rejects identities outside the exact legacy navigation scope: %s",
    (id) => {
      expect(parseLegacyResourceId(id)).toBeUndefined();
    }
  );
});
