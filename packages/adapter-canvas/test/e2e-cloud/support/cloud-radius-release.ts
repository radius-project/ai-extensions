import { expectSuccess, type CloudCommandPort } from "./cloud-command-port.js";

export async function configureCloudRadiusRelease(
  commands: Pick<CloudCommandPort, "runGh">,
  repository: string,
  environment: string,
  release: string | undefined
): Promise<void> {
  if (!release) return;
  const parsed: unknown = JSON.parse(release);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("tag" in parsed) ||
    typeof parsed.tag !== "string" ||
    parsed.tag !== parsed.tag.trim() ||
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(
      parsed.tag
    ) ||
    !("commit" in parsed) ||
    typeof parsed.commit !== "string" ||
    parsed.commit.length !== 40 ||
    !/^[0-9a-f]{40}$/u.test(parsed.commit) ||
    !("checksum" in parsed) ||
    typeof parsed.checksum !== "string" ||
    parsed.checksum.length !== 64 ||
    !/^[0-9a-f]{64}$/u.test(parsed.checksum)
  ) {
    throw new Error(
      "RADIUS_CLOUD_E2E_RELEASE must contain a release tag, commit, and installer checksum."
    );
  }
  expectSuccess(
    await commands.runGh([
      "api",
      "--method",
      "POST",
      `repos/${repository}/environments/${encodeURIComponent(environment)}/variables`,
      "-f",
      "name=RADIUS_RELEASE_OVERRIDE",
      "-f",
      `value=${release}`
    ]),
    "configure the cloud test environment's Radius release"
  );
}
