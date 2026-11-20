import { extractAppName } from "../deployment-lookup-policy.js";

export type ApplicationDefinitionRead =
  | { kind: "read"; source: string }
  | { kind: "missing" }
  | { kind: "unavailable" };

export type ApplicationDefinitionInspection =
  | { kind: "defined"; name: string; path: string; branch: string }
  | { kind: "unconfirmed"; fallbackName: string; unavailable: boolean };

export async function inspectApplicationDefinition(
  repo: string,
  branch: string,
  read: (path: string, branch: string) => Promise<ApplicationDefinitionRead>
): Promise<ApplicationDefinitionInspection> {
  const ref = branch || "main";
  let unavailable = false;
  for (const path of [".radius/app.bicep", "app.bicep"]) {
    const definition = await read(path, ref);
    if (definition.kind === "read") {
      const name = extractAppName(definition.source);
      if (name) {
        return unavailable ?
            { kind: "unconfirmed", fallbackName: name, unavailable }
          : { kind: "defined", name, path, branch: ref };
      }
    } else if (definition.kind === "unavailable") {
      unavailable = true;
    }
  }
  return {
    kind: "unconfirmed",
    fallbackName: repo.split("/").pop() || repo,
    unavailable
  };
}

export async function inspectDeploymentListings<T>(
  readNames: () => Promise<string[]>,
  inspect: (environment: string) => Promise<T>
) {
  const names = [...new Set(await readNames())];
  const results = await Promise.allSettled(names.map((name) => inspect(name)));
  return results.map((result, index) => ({
    environment: names[index],
    result
  }));
}
