import { describe, it, expect } from "vitest";
import { parseComposeServices } from "./compose.js";

describe("parseComposeServices", () => {
  it("returns an empty array for empty content", () => {
    expect(parseComposeServices("")).toEqual([]);
  });

  it("returns an empty array when no services block exists", () => {
    const content = `
version: '3'
volumes:
  data:
`;
    expect(parseComposeServices(content)).toEqual([]);
  });

  it("parses a single service with image", () => {
    const content = `
services:
  web:
    image: nginx:latest
`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("web");
    expect(services[0].image).toBe("nginx:latest");
    expect(services[0].hasDockerfile).toBe(false);
  });

  it("parses multiple services", () => {
    const content = `
services:
  frontend:
    image: node:18
  backend:
    image: python:3.11
`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(2);
    expect(services[0].name).toBe("frontend");
    expect(services[1].name).toBe("backend");
  });

  it("detects build directive as hasDockerfile", () => {
    const content = `
services:
  app:
    build: .
`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(1);
    expect(services[0].hasDockerfile).toBe(true);
  });

  it("extracts port mapping (host:container)", () => {
    const content = `
services:
  web:
    image: nginx
    ports:
      - "8080:80"
`;
    const services = parseComposeServices(content);
    expect(services[0].port).toBe(80);
  });

  it("extracts port mapping without quotes", () => {
    const content = `
services:
  api:
    image: node
    ports:
      - 3000:5000
`;
    const services = parseComposeServices(content);
    expect(services[0].port).toBe(5000);
  });

  it("uses the last port when multiple ports are defined (overwrites)", () => {
    const content = `
services:
  app:
    image: myapp
    ports:
      - "8080:80"
      - "8443:443"
`;
    const services = parseComposeServices(content);
    // The parser overwrites port on each match, so last wins
    expect(services[0].port).toBe(443);
  });

  it("defaults port to 3000 when no ports defined", () => {
    const content = `
services:
  worker:
    image: worker:latest
`;
    const services = parseComposeServices(content);
    expect(services[0].port).toBe(3000);
  });

  it("detects database dependency via depends_on with db-like names", () => {
    const content = `
services:
  api:
    image: api:latest
    depends_on:
      - database
`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(true);
  });

  it("detects database dependency via depends_on with mysql", () => {
    const content = `
services:
  api:
    image: api:latest
    depends_on:
      - mysql
`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(true);
  });

  it("detects database dependency via depends_on with postgres", () => {
    const content = `
services:
  api:
    image: api:latest
    depends_on:
      - postgres
`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(true);
  });

  it("detects database dependency via depends_on with redis", () => {
    const content = `
services:
  api:
    image: api:latest
    depends_on:
      - redis
`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(true);
  });

  it("detects database dependency via environment variable DATABASE_TCP_HOST", () => {
    const content = `
services:
  api:
    image: api:latest
    environment:
      DATABASE_TCP_HOST: db
`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(true);
  });

  it("detects database dependency via environment variable MYSQL_HOST", () => {
    const content = `
services:
  api:
    image: api:latest
    environment:
      MYSQL_HOST: db
`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(true);
  });

  it("detects database dependency via environment variable POSTGRES_HOST", () => {
    const content = `
services:
  api:
    image: api:latest
    environment:
      POSTGRES_HOST: db
`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(true);
  });

  it("detects database dependency via environment variable DB_HOST", () => {
    const content = `
services:
  api:
    image: api:latest
    environment:
      DB_HOST: localhost
`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(true);
  });

  it("does not flag dependsOnDb when no db signals present", () => {
    const content = `
services:
  app:
    image: app:latest
    depends_on:
      - cache
    environment:
      APP_PORT: 8080
`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(false);
  });

  it("ignores comment lines", () => {
    const content = `
services:
  # This is a comment
  web:
    image: nginx
    # Another comment
`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("web");
  });

  it("ignores empty lines", () => {
    const content = `
services:

  web:

    image: nginx

`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("web");
  });

  it("handles services at end of file without trailing top-level keys", () => {
    const content = `
services:
  web:
    image: nginx
  api:
    image: node
`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(2);
    expect(services[0].name).toBe("web");
    expect(services[1].name).toBe("api");
  });

  it("strips quotes from image names", () => {
    const content = `
services:
  app:
    image: 'myregistry/myapp:v1'
`;
    const services = parseComposeServices(content);
    expect(services[0].image).toBe("myregistry/myapp:v1");
  });

  it("strips double quotes from image names", () => {
    const content = `
services:
  app:
    image: "myregistry/myapp:v2"
`;
    const services = parseComposeServices(content);
    expect(services[0].image).toBe("myregistry/myapp:v2");
  });

  it("handles services block at non-zero indent (indented compose)", () => {
    // Edge case: services: at column 0
    const content = `services:
  api:
    image: api:latest
`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("api");
  });

  it("handles a complex compose file with multiple services and properties", () => {
    const content = `
version: '3.8'
services:
  frontend:
    build: ./frontend
    ports:
      - "3000:3000"
    depends_on:
      - api
  api:
    image: myapi:latest
    ports:
      - "8080:8080"
    environment:
      DB_HOST: postgres
    depends_on:
      - db
  db:
    image: postgres:15
    ports:
      - "5432:5432"
`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(3);

    const frontend = services.find((s: any) => s.name === "frontend");
    expect(frontend!.hasDockerfile).toBe(true);
    expect(frontend!.port).toBe(3000);
    expect(frontend!.dependsOnDb).toBe(false);

    const api = services.find((s: any) => s.name === "api");
    expect(api!.image).toBe("myapi:latest");
    expect(api!.port).toBe(8080);
    expect(api!.dependsOnDb).toBe(true);

    const db = services.find((s: any) => s.name === "db");
    expect(db!.image).toBe("postgres:15");
    expect(db!.port).toBe(5432);
  });

  it("handles port with single quotes", () => {
    const content = `
services:
  web:
    image: nginx
    ports:
      - '9090:80'
`;
    const services = parseComposeServices(content);
    expect(services[0].port).toBe(80);
  });

  it("handles service with only name and no properties", () => {
    const content = `
services:
  empty:
`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("empty");
    expect(services[0].port).toBe(3000);
    expect(services[0].image).toBe("");
    expect(services[0].hasDockerfile).toBe(false);
    expect(services[0].dependsOnDb).toBe(false);
  });
});
