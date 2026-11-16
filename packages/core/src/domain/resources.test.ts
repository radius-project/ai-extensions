import { describe, expectTypeOf, it } from "vitest";
import type { ApplicationProperties, Resource } from "./resources.js";

describe("Resource metadata contract", () => {
  it("accepts omitted, empty, and populated system metadata without casts", () => {
    const application = {
      id: "/planes/radius/local/resourceGroups/test/providers/Radius.Core/applications/app",
      type: "Radius.Core/applications",
      name: "app",
      properties: {
        provisioningState: "Succeeded",
        environment: "/environment/default"
      }
    } satisfies Resource<ApplicationProperties>;
    const empty = {
      ...application,
      systemData: {}
    } satisfies Resource<ApplicationProperties>;
    const populated = {
      ...application,
      systemData: {
        createdAt: "2026-01-01T00:00:00Z",
        createdBy: "test",
        lastModifiedAt: "2026-01-02T00:00:00Z",
        revision: 1,
        imported: true,
        source: { kind: "test" },
        annotations: null
      }
    } satisfies Resource<ApplicationProperties>;

    expectTypeOf(application).toExtend<Resource<ApplicationProperties>>();
    expectTypeOf(empty).toExtend<Resource<ApplicationProperties>>();
    expectTypeOf(populated).toExtend<Resource<ApplicationProperties>>();
  });

  it("keeps identity, tags, properties, and metadata container types checked", () => {
    type Application = Resource<ApplicationProperties>;

    expectTypeOf<Omit<Application, "id">>().not.toExtend<Application>();
    expectTypeOf<Omit<Application, "type">>().not.toExtend<Application>();
    expectTypeOf<Omit<Application, "name">>().not.toExtend<Application>();
    expectTypeOf<Omit<Application, "properties">>().not.toExtend<Application>();
    expectTypeOf<Application["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Application["type"]>().toEqualTypeOf<string>();
    expectTypeOf<Application["name"]>().toEqualTypeOf<string>();
    expectTypeOf<
      Application["properties"]
    >().toEqualTypeOf<ApplicationProperties>();
    expectTypeOf<{
      provisioningState: string;
      environment: number;
    }>().not.toExtend<Application["properties"]>();
    expectTypeOf<{ owner: number }>().not.toExtend<Application["tags"]>();
    expectTypeOf<string>().not.toExtend<Application["systemData"]>();
    expectTypeOf<Application["systemData"]>().toEqualTypeOf<
      Record<string, unknown> | undefined
    >();
  });
});
