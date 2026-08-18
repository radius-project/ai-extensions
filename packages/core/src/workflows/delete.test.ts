import { describe, expect, it } from "vitest";
import {
  generateDeleteWorkflow,
  DELETE_APP_DISPATCHER_FILE,
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_AZURE_FILE,
  DELETE_ENV_GUARD_STEP_NAME,
  DELETE_AZURE_FILE,
  DELETE_AWS_FILE,
  DELETE_RADIUS_REF
} from "./delete.js";

// Minimal stand-ins for the upstream delete templates. The dispatchers only use
// the workflow_dispatch `{{ENV}}` default; the provider workflows also pin their
// composite actions to `{{RADIUS_REF}}`.
const DISPATCHER = `name: dispatcher
on:
  workflow_dispatch:
    inputs:
      environment:
        default: "{{ENV}}"
jobs:
  detect:
    runs-on: ubuntu-latest
`;
const PROVIDER = `name: provider
jobs:
  delete:
    steps:
      - uses: radius-project/radius/.github/extension/actions/delete-resource@{{RADIUS_REF}}
`;
// The environment-delete provider carries the ai-extensions-owned guard step and
// pins its composite actions to `{{RADIUS_REF}}` like the other providers.
const ENV_PROVIDER = `name: env-provider
jobs:
  azure:
    steps:
      - uses: radius-project/radius/.github/extension/actions/delete-resource@{{RADIUS_REF}}
      - name: ${DELETE_ENV_GUARD_STEP_NAME}
        run: rad application list --output json
`;

function templates(): Record<string, string> {
  return {
    [DELETE_APP_DISPATCHER_FILE]: DISPATCHER,
    [DELETE_ENV_DISPATCHER_FILE]: DISPATCHER,
    [DELETE_ENV_AZURE_FILE]: ENV_PROVIDER,
    [DELETE_AZURE_FILE]: PROVIDER,
    [DELETE_AWS_FILE]: PROVIDER
  };
}

describe("generateDeleteWorkflow", () => {
  it("emits both dispatchers plus every provider workflow", () => {
    const files = generateDeleteWorkflow("dev", templates());
    expect(Object.keys(files).sort()).toEqual(
      [
        DELETE_AWS_FILE,
        DELETE_AZURE_FILE,
        DELETE_ENV_AZURE_FILE,
        DELETE_ENV_DISPATCHER_FILE,
        DELETE_APP_DISPATCHER_FILE
      ].sort()
    );
  });

  it("fills {{ENV}} into both dispatchers", () => {
    const files = generateDeleteWorkflow("staging", templates());
    expect(files[DELETE_APP_DISPATCHER_FILE]).toContain('default: "staging"');
    expect(files[DELETE_ENV_DISPATCHER_FILE]).toContain('default: "staging"');
    expect(files[DELETE_ENV_DISPATCHER_FILE]).not.toContain("{{ENV}}");
  });

  it("pins {{RADIUS_REF}} into the provider workflows", () => {
    const files = generateDeleteWorkflow("dev", templates());
    expect(files[DELETE_AZURE_FILE]).toContain(
      `delete-resource@${DELETE_RADIUS_REF}`
    );
    expect(files[DELETE_AZURE_FILE]).not.toContain("{{RADIUS_REF}}");
  });

  it("fills the environment-delete provider and keeps the guard step name", () => {
    const files = generateDeleteWorkflow("dev", templates());
    expect(files[DELETE_ENV_AZURE_FILE]).toContain(
      `delete-resource@${DELETE_RADIUS_REF}`
    );
    expect(files[DELETE_ENV_AZURE_FILE]).not.toContain("{{RADIUS_REF}}");
    expect(files[DELETE_ENV_AZURE_FILE]).toContain(
      `name: ${DELETE_ENV_GUARD_STEP_NAME}`
    );
  });

  it("throws when a required template is missing", () => {
    const partial = templates();
    delete partial[DELETE_ENV_DISPATCHER_FILE];
    expect(() => generateDeleteWorkflow("dev", partial)).toThrow(
      /Missing delete template "delete-environment.yml"/
    );
  });

  it("throws when the environment-delete provider template is missing", () => {
    const partial = templates();
    delete partial[DELETE_ENV_AZURE_FILE];
    expect(() => generateDeleteWorkflow("dev", partial)).toThrow(
      /Missing delete template "delete-environment-azure.yml"/
    );
  });
});
