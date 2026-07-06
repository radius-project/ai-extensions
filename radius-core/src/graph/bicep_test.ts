import { describe, it, expect, vi } from "vitest";
import { parseBicepResources, buildGraphFromBicep } from "./bicep.js";

// Mock compileBicepToARM to avoid shelling out to bicep CLI in tests
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: any, _args: any, _opts: any, cb: any) => {
    if (cb) cb(new Error("bicep not available"), "", "");
    return {} as any;
  }),
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

describe("parseBicepResources", () => {
  it("returns empty array for empty input", () => {
    expect(parseBicepResources("")).toEqual([]);
    expect(parseBicepResources("", "app.bicep")).toEqual([]);
  });

  it("parses a single resource", () => {
    const bicep = `
resource container 'Radius.Compute/containers@2024-01-01' = {
  name: 'frontend'
  properties: {
    application: application
  }
}
`;
    const result = parseBicepResources(bicep);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const frontend = result.find((r) => r.name === "frontend");
    expect(frontend).toBeDefined();
    expect(frontend!.type).toBe("Radius.Compute/containers");
    expect(frontend!.id).toContain("Radius.Compute/containers/frontend");
  });

  it("detects outbound connections between resources", () => {
    const bicep = `
resource container 'Radius.Compute/containers@2024-01-01' = {
  name: 'frontend'
  properties: {
    connections: {
      db: {
        source: db.id
      }
    }
  }
}

resource db 'Radius.Data/mySqlDatabases@2024-01-01' = {
  name: 'mydb'
  properties: {}
}
`;
    const result = parseBicepResources(bicep);
    const frontend = result.find((r) => r.name === "frontend");
    expect(frontend).toBeDefined();
    const outbound = frontend!.connections.filter((c: any) => c.direction === "Outbound");
    expect(outbound.length).toBeGreaterThanOrEqual(1);
    expect(outbound.some((c: any) => c.id.includes("mySqlDatabases/mydb"))).toBe(true);
  });

  it("adds inbound connections to target resources", () => {
    const bicep = `
resource container 'Radius.Compute/containers@2024-01-01' = {
  name: 'frontend'
  properties: {
    connections: {
      db: {
        source: db.id
      }
    }
  }
}

resource db 'Radius.Data/mySqlDatabases@2024-01-01' = {
  name: 'mydb'
  properties: {}
}
`;
    const result = parseBicepResources(bicep);
    const db = result.find((r) => r.name === "mydb");
    expect(db).toBeDefined();
    const inbound = db!.connections.filter((c: any) => c.direction === "Inbound");
    expect(inbound.length).toBeGreaterThanOrEqual(1);
  });

  it("synthesizes an application node when application is a param", () => {
    const bicep = `
param application string

resource container 'Radius.Compute/containers@2024-01-01' = {
  name: 'myapp-container'
  properties: {
    application: application
  }
}
`;
    const result = parseBicepResources(bicep);
    const appNode = result.find((r) => r.type === "Radius.Core/applications");
    expect(appNode).toBeDefined();
    // The container should have a connection to the application node
    const container = result.find((r) => r.name === "myapp-container");
    expect(container).toBeDefined();
    const appConn = container!.connections.find((c: any) => c.id === appNode!.id);
    expect(appConn).toBeDefined();
  });

  it("does not synthesize application node when application is a resource", () => {
    const bicep = `
resource app 'applications.core/applications@2024-01-01' = {
  name: 'myapp'
  properties: {}
}

resource container 'Radius.Compute/containers@2024-01-01' = {
  name: 'frontend'
  properties: {
    application: app.id
  }
}
`;
    const result = parseBicepResources(bicep);
    const synthApp = result.find((r) => r.type === "Radius.Core/applications");
    expect(synthApp).toBeUndefined();
  });

  it("includes definitionFile and definitionLine", () => {
    const bicep = `resource svc 'Radius.Compute/containers@2024-01-01' = {
  name: 'svc'
  properties: {}
}
`;
    const result = parseBicepResources(bicep, "my/app.bicep");
    expect(result[0].definitionFile).toBe("my/app.bicep");
    expect(result[0].definitionLine).toBeGreaterThanOrEqual(1);
  });

  it("extracts codeReference property", () => {
    const bicep = `
resource container 'Radius.Compute/containers@2024-01-01' = {
  name: 'frontend'
  properties: {
    codeReference: './src/frontend'
  }
}
`;
    const result = parseBicepResources(bicep);
    const frontend = result.find((r) => r.name === "frontend");
    expect(frontend!.codeReference).toBe("./src/frontend");
  });

  it("handles multiple resources with no connections", () => {
    const bicep = `
resource a 'Radius.Compute/containers@2024-01-01' = {
  name: 'svc-a'
  properties: {}
}

resource b 'Radius.Data/redisCaches@2024-01-01' = {
  name: 'cache'
  properties: {}
}
`;
    const result = parseBicepResources(bicep);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.connections.length === 0)).toBe(true);
  });
});

describe("buildGraphFromBicep", () => {
  it("returns empty array for empty content", async () => {
    const result = await buildGraphFromBicep("");
    expect(result).toEqual([]);
  });

  it("falls back to regex parser when bicep CLI is unavailable", async () => {
    const bicep = `
resource container 'Radius.Compute/containers@2024-01-01' = {
  name: 'myapp'
  properties: {}
}
`;
    const result = await buildGraphFromBicep(bicep);
    // Should still produce results via the regex fallback path
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].name).toBe("myapp");
    expect(result[0].definitionFile).toBe(".radius/app.bicep");
  });

  it("respects custom definitionFile parameter", async () => {
    const bicep = `
resource svc 'Radius.Compute/containers@2024-01-01' = {
  name: 'svc'
  properties: {}
}
`;
    const result = await buildGraphFromBicep(bicep, "custom/path.bicep");
    expect(result[0].definitionFile).toBe("custom/path.bicep");
  });
});
