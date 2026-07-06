import { describe, it, expect } from "vitest";
import { parseBicepResources } from "./bicep.js";
import { buildResourceID } from "./model.js";

describe("parseBicepResources", () => {
  it("returns an empty array for empty content", () => {
    expect(parseBicepResources("")).toEqual([]);
    expect(parseBicepResources(null as any)).toEqual([]);
  });

  it("parses a single resource declaration", () => {
    const content = `
resource frontend 'Radius.Compute/containers@2023-10-01-preview' = {
  name: 'frontend'
  properties: {}
}
`;
    const resources = parseBicepResources(content);
    expect(resources).toHaveLength(1);
    expect(resources[0].name).toBe("frontend");
    expect(resources[0].type).toBe("Radius.Compute/containers");
    expect(resources[0].id).toBe(buildResourceID("Radius.Compute/containers", "frontend"));
  });

  it("uses the definitionFile parameter", () => {
    const content = `resource api 'Radius.Compute/containers@2023-10-01-preview' = {
  name: 'api'
  properties: {}
}`;
    const resources = parseBicepResources(content, "myapp/app.bicep");
    expect(resources[0].definitionFile).toBe("myapp/app.bicep");
  });

  it("defaults definitionFile to .radius/app.bicep", () => {
    const content = `resource api 'Radius.Compute/containers@2023-10-01-preview' = {
  name: 'api'
  properties: {}
}`;
    const resources = parseBicepResources(content);
    expect(resources[0].definitionFile).toBe(".radius/app.bicep");
  });

  it("detects outbound connections via symbolic references", () => {
    const content = `
resource frontend 'Radius.Compute/containers@2023-10-01-preview' = {
  name: 'frontend'
  properties: {
    connections: {
      db: { source: db.id }
    }
  }
}

resource db 'Radius.Data/mongoDatabases@2023-10-01-preview' = {
  name: 'mydb'
  properties: {}
}
`;
    const resources = parseBicepResources(content);
    const frontend = resources.find((r) => r.name === "frontend");
    expect(frontend).toBeDefined();
    const outbound = frontend!.connections.filter((c: any) => c.direction === "Outbound");
    expect(outbound).toHaveLength(1);
    expect(outbound[0].id).toBe(buildResourceID("Radius.Data/mongoDatabases", "mydb"));
  });

  it("adds inbound connections to the referenced resource", () => {
    const content = `
resource frontend 'Radius.Compute/containers@2023-10-01-preview' = {
  name: 'frontend'
  properties: {
    connections: {
      db: { source: db.id }
    }
  }
}

resource db 'Radius.Data/mongoDatabases@2023-10-01-preview' = {
  name: 'mydb'
  properties: {}
}
`;
    const resources = parseBicepResources(content);
    const db = resources.find((r) => r.name === "mydb");
    const inbound = db!.connections.filter((c: any) => c.direction === "Inbound");
    expect(inbound).toHaveLength(1);
    expect(inbound[0].id).toBe(buildResourceID("Radius.Compute/containers", "frontend"));
  });

  it("synthesizes an app node when application is a param and no resource type contains 'applications'", () => {
    // hasAppResource checks for the string "applications" in any resource type,
    // so synthesis only fires when all types are outside that namespace.
    const content = `
param application string

resource cache 'Radius.Data/redisCaches@2023-10-01-preview' = {
  name: 'mycache'
  properties: {
    application: application
  }
}
`;
    const resources = parseBicepResources(content);
    const appNode = resources.find((r) => r.type === "Radius.Core/applications");
    expect(appNode).toBeDefined();
    expect(appNode!.id).toBe(buildResourceID("Radius.Core/applications", "application"));
  });

  it("does not synthesize an app node when application is already a resource", () => {
    // Even with param application string, synthesis is suppressed when an applications resource exists.
    const content = `
param application string

resource myApp 'Radius.Core/applications@2023-10-01-preview' = {
  name: 'myapp'
  properties: {}
}
resource api 'Radius.Compute/containers@2023-10-01-preview' = {
  name: 'api'
  properties: {}
}
`;
    const resources = parseBicepResources(content);
    const appNodes = resources.filter((r) => r.type === "Radius.Core/applications");
    // Exactly 1 app node: the declared resource; no extra synthesized node added.
    expect(appNodes).toHaveLength(1);
  });

  it("extracts codeReference when present", () => {
    const content = `
resource api 'Radius.Compute/containers@2023-10-01-preview' = {
  name: 'api'
  properties: {
    codeReference: 'src/api'
  }
}
`;
    const resources = parseBicepResources(content);
    expect(resources[0].codeReference).toBe("src/api");
  });

  it("sets codeReference to empty string when absent", () => {
    const content = `
resource api 'Radius.Compute/containers@2023-10-01-preview' = {
  name: 'api'
  properties: {}
}
`;
    const resources = parseBicepResources(content);
    expect(resources[0].codeReference).toBe("");
  });

  it("records the definition line number for each resource", () => {
    const content = `resource first 'Radius.Compute/containers@2023-10-01-preview' = {
  name: 'first'
  properties: {}
}

resource second 'Radius.Compute/containers@2023-10-01-preview' = {
  name: 'second'
  properties: {}
}
`;
    const resources = parseBicepResources(content);
    const first = resources.find((r) => r.name === "first");
    const second = resources.find((r) => r.name === "second");
    expect(first!.definitionLine).toBeLessThan(second!.definitionLine);
  });
});
