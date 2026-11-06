import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const STEP = "Create Radius environment and deploy provider recipe pack";
const ACCOUNT = "123456789012";
const ROLE_PATH = "/radius/apps/dev-0123456789ab/";
const BOUNDARY = `arn:aws:iam::${ACCOUNT}:policy${ROLE_PATH}radius-app-dev-0123456789ab`;
const REF = "0".repeat(40);

async function packScript(): Promise<string> {
  const workflow: unknown = parse(
    await readFile(
      new URL(
        "../../../../.github/extension/run-rad-commands-aws.yml",
        import.meta.url
      ),
      "utf8"
    )
  );
  const jobs =
    typeof workflow === "object" && workflow !== null && "jobs" in workflow ?
      workflow.jobs
    : null;
  for (const job of Object.values(jobs ?? {})) {
    const steps: unknown =
      typeof job === "object" && job !== null && "steps" in job ?
        job.steps
      : [];
    for (const step of Array.isArray(steps) ? steps : []) {
      if (step?.name === STEP && typeof step.run === "string") return step.run;
    }
  }
  throw new Error(`Missing step "${STEP}"`);
}

// The aws-eks pack at the commit the extension pins. See recipe-pack.test.ts.
const PINNED_PACK = new URL(
  "../../../core/src/modeling/testdata/aws-eks.bicep",
  import.meta.url
);

// Runs the step with `rad` and `curl` replaced, and answers the arguments the
// pinned recipe pack was deployed with, or the step's error. The served pack
// already has its aws-eks recipes pinned to REF, so `sed` is a no-op and the
// step's GNU `sed -i -E` doesn't stop it on macOS.
async function deployPack(variables: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "radius-pack-params-"));
  try {
    const log = path.join(root, "rad.log");
    const pack = path.join(root, "pinned-pack.bicep");
    await writeFile(
      pack,
      (await readFile(PINNED_PACK, "utf8")).replace(
        /(aws-eks-recipes\/[a-z0-9._-]+):latest'/g,
        `$1:${REF}'`
      )
    );
    await writeFile(
      path.join(root, "rad"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`,
      { mode: 0o700 }
    );
    await writeFile(
      path.join(root, "curl"),
      `#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp "${pack}" "$2"\n`,
      { mode: 0o700 }
    );
    await writeFile(path.join(root, "sed"), "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(
      path.join(root, "catalog.sh"),
      "radius_contrib_pin_kube_recipes() { :; }\n"
    );
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", await packScript()],
      {
        cwd: root,
        env: {
          PATH: `${root}${path.delimiter}${process.env.PATH || ""}`,
          RADIUS_CONTRIB_CATALOG_HELPER: path.join(root, "catalog.sh"),
          GITHUB_OUTPUT: path.join(root, "output"),
          APP_FILE: path.join(root, "app", "app.bicep"),
          ENVIRONMENT: "dev",
          KUBERNETES_NAMESPACE: "default",
          RADIUS_BUILD_REGISTRY: "ghcr.io/octo/shop",
          RADIUS_ROUTES_GATEWAY_NAME: "radius",
          RADIUS_ROUTES_GATEWAY_NAMESPACE: "radius-system",
          AWS_ACCOUNT_ID: ACCOUNT,
          AWS_REGION: "us-west-2",
          AWS_EKS_CLUSTER_NAME: "shop",
          RADIUS_SUBNET_IDS: "subnet-0a,subnet-0b",
          RECIPE_PACK_URL: `https://example.invalid/${REF}/aws-eks.bicep`,
          RECIPE_PACK_REF: REF,
          AWS_APP_ROLE_PATH: "",
          AWS_APP_BOUNDARY_ARN: "",
          ...variables
        },
        encoding: "utf8",
        timeout: 5000
      }
    );
    expect(result.error).toBeUndefined();
    if (result.status !== 0) return { error: result.stderr };
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    return { pack: calls.find((call) => call.includes("--environment")) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")(
  "the AWS recipe pack's app role parameters",
  () => {
    it("passes the role path and boundary that setup recorded", async () => {
      const { pack } = await deployPack({
        AWS_APP_ROLE_PATH: ROLE_PATH,
        AWS_APP_BOUNDARY_ARN: BOUNDARY
      });
      expect(pack).toContain(`--parameters appRolePath=${ROLE_PATH}`);
      expect(pack).toContain(
        `--parameters appPermissionsBoundaryArn=${BOUNDARY}`
      );
    });

    it("passes only parameters that the pinned pack declares", async () => {
      const declared = [
        ...(await readFile(PINNED_PACK, "utf8")).matchAll(/^param (\w+) /gm)
      ].map((match) => match[1]);
      const { pack } = await deployPack({
        AWS_APP_ROLE_PATH: ROLE_PATH,
        AWS_APP_BOUNDARY_ARN: BOUNDARY
      });
      const passed = [...(pack ?? "").matchAll(/--parameters (\w+)=/g)].map(
        (match) => match[1]
      );
      expect(passed).toHaveLength(8);
      expect(declared).toEqual(expect.arrayContaining(passed));
    });

    it("leaves them out for an environment set up before them", async () => {
      const { pack } = await deployPack({});
      expect(pack).toContain("--parameters eksClusterName=shop");
      expect(pack).not.toContain("appRolePath");
      expect(pack).not.toContain("appPermissionsBoundaryArn");
    });

    it.each([
      ["only one is set", { AWS_APP_ROLE_PATH: ROLE_PATH }],
      [
        "the boundary is outside the role path",
        {
          AWS_APP_ROLE_PATH: ROLE_PATH,
          AWS_APP_BOUNDARY_ARN: `arn:aws:iam::${ACCOUNT}:policy/AdministratorAccess`
        }
      ],
      [
        "the path is not under /radius/apps/",
        {
          AWS_APP_ROLE_PATH: "/",
          AWS_APP_BOUNDARY_ARN: `arn:aws:iam::${ACCOUNT}:policy/radius-app-`
        }
      ]
    ])("stops when %s", async (_label, variables) => {
      expect(await deployPack(variables)).toEqual({
        error: expect.stringContaining(
          "AWS_APP_ROLE_PATH and AWS_APP_BOUNDARY_ARN must be the values environment setup recorded"
        )
      });
    });
  }
);
