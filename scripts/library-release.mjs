import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./module-entry.mjs";
import { repoRoot } from "./plugins.mjs";
import { libraryPackages } from "./libraries.mjs";

export function libraryReleasePlan(root = repoRoot) {
  const libraries = libraryPackages(root);
  assert.ok(libraries.length > 0, "No public npm libraries were discovered.");
  const releases = libraries.map(({ directory, manifest }) => {
    const { name, version } = manifest;
    assert.match(name, /^@radius-project\/[a-z][a-z0-9-]*$/);
    assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    assert.equal(manifest.private, false, `${name} is private.`);
    assert.equal(
      manifest.publishConfig.registry,
      "https://registry.npmjs.org/"
    );
    const changelog = readFileSync(join(directory, "CHANGELOG.md"), "utf8");
    const sections = changelog.split(/^## /m).slice(1);
    const section = sections.find(
      (value) => value.split(/\r?\n/, 1)[0] === version
    );
    assert.ok(section, `${name}@${version} has no versioned release notes.`);
    const notes = section.slice(version.length).trim();
    assert.ok(notes, `${name}@${version} has empty release notes.`);
    return {
      name,
      version,
      tarball: `${name.replace("@", "").replace("/", "-")}-${version}.tgz`,
      notes,
      dependencies: Object.keys(manifest.dependencies ?? {}).filter(
        (dependency) =>
          libraries.some(({ manifest }) => manifest.name === dependency)
      )
    };
  });
  const ordered = [];
  const pending = new Set(releases);
  while (pending.size > 0) {
    const ready = [...pending].filter((release) =>
      release.dependencies.every((name) =>
        ordered.some((previous) => previous.name === name)
      )
    );
    assert.ok(ready.length > 0, "Library dependencies contain a cycle.");
    for (const release of ready) {
      pending.delete(release);
      ordered.push(release);
    }
  }
  return ordered;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  console.log(JSON.stringify(libraryReleasePlan()));
}
