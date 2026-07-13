import { describe, it, expect } from "vitest";
import { parseComposeServices } from "./compose.js";

describe("parseComposeServices", () => {
  it("returns an empty array for empty content", () => {
    expect(parseComposeServices("")).toEqual([]);
  });

  it("returns an empty array when there is no services block", () => {
    const content = `version: "3"
volumes:
  data: {}`;
    expect(parseComposeServices(content)).toEqual([]);
  });

  it("parses a single service with defaults", () => {
    const content = `services:
  web:
    image: nginx`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(1);
    expect(services[0]).toEqual({
      name: "web",
      port: 3000,
      image: "nginx",
      hasDockerfile: false,
      dependsOnDb: false,
    });
  });

  it("parses multiple services", () => {
    const content = `services:
  api:
    image: node:18
  worker:
    image: python:3.11`;
    const services = parseComposeServices(content);
    expect(services.map((s) => s.name)).toEqual(["api", "worker"]);
    expect(services[0].image).toBe("node:18");
    expect(services[1].image).toBe("python:3.11");
  });

  it("strips quotes from image values", () => {
    const content = `services:
  web:
    image: "nginx:latest"`;
    const services = parseComposeServices(content);
    expect(services[0].image).toBe("nginx:latest");
  });

  it("marks a service with a build directive as having a Dockerfile", () => {
    const content = `services:
  app:
    build: .`;
    const services = parseComposeServices(content);
    expect(services[0].hasDockerfile).toBe(true);
  });

  it("extracts the container (target) port from a ports mapping", () => {
    const content = `services:
  web:
    image: nginx
    ports:
      - "8080:80"`;
    const services = parseComposeServices(content);
    expect(services[0].port).toBe(80);
  });

  it("detects a database dependency via depends_on", () => {
    const content = `services:
  api:
    image: node
    depends_on:
      - database`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(true);
  });

  it("detects a database dependency via a connection env var", () => {
    const content = `services:
  api:
    image: node
    environment:
      - MYSQL_HOST=db`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(true);
  });

  it("does not flag dependsOnDb when there is no db reference", () => {
    const content = `services:
  api:
    image: node
    environment:
      - LOG_LEVEL=debug`;
    const services = parseComposeServices(content);
    expect(services[0].dependsOnDb).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    const content = `# top level comment
services:
  # a service
  web:
    image: nginx

  db:
    image: mysql`;
    const services = parseComposeServices(content);
    expect(services.map((s) => s.name)).toEqual(["web", "db"]);
  });

  it("stops parsing at a top-level key after services", () => {
    const content = `services:
  web:
    image: nginx
volumes:
  data: {}`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("web");
  });

  it("parses a realistic multi-service compose file", () => {
    const content = `version: "3.8"
services:
  api:
    build: ./api
    ports:
      - "3000:3000"
    depends_on:
      - db
  db:
    image: mysql:8.0
    ports:
      - "3306:3306"`;
    const services = parseComposeServices(content);
    expect(services).toHaveLength(2);
    const api = services[0];
    expect(api.name).toBe("api");
    expect(api.hasDockerfile).toBe(true);
    expect(api.port).toBe(3000);
    expect(api.dependsOnDb).toBe(true);
    const db = services[1];
    expect(db.name).toBe("db");
    expect(db.image).toBe("mysql:8.0");
    expect(db.port).toBe(3306);
  });
});
