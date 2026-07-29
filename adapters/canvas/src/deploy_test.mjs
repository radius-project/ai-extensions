import { describe, expect, it } from "vitest";
import {
    explainOidcEnterpriseClaim,
    explainRepoAccessForEnvSetup,
    isRepoNotFoundError,
    extractErrorLines,
    findDeployJobId,
    parseRadDeployProgress,
    extractAppGraphJson,
} from "./deploy.mjs";

// The exact rejection surfaced by GitHub Actions' "Azure Login (OIDC)" step when
// a personal-account repo hits a tenant that enforces the enterprise claim.
const MS_ERROR =
    "AADSTS7002381: Federated identity credentials issued by " +
    "'https://token.actions.githubusercontent.com/' for applications or managed " +
    "identities registered in this tenant must contain the enterprise claim with " +
    "value 'microsoft', 'github' or 'microsoftopensource' but actual value is ''.";

describe("explainOidcEnterpriseClaim", () => {
    it("explains the Microsoft-tenant rejection, parsing accepted + empty actual value", () => {
        const out = explainOidcEnterpriseClaim(MS_ERROR);
        expect(out).not.toBe("");
        // All three accepted values are surfaced dynamically (parsed, not hardcoded).
        expect(out).toContain("microsoft");
        expect(out).toContain("github");
        expect(out).toContain("microsoftopensource");
        // Frames it as the missing "enterprise" claim.
        expect(out.toLowerCase()).toContain("enterprise");
        expect(out).toContain("missing");
        // Explains the personal-account root cause and the empty actual value.
        expect(out.toLowerCase()).toContain("personal");
        expect(out).toContain("empty");
    });

    it("is tenant-agnostic: surfaces a non-Microsoft tenant's accepted + actual values", () => {
        const log =
            "AADSTS7002381: ... must contain the enterprise claim with value " +
            "'contoso' or 'fabrikam' but actual value is 'personal-acct'.";
        const out = explainOidcEnterpriseClaim(log);
        expect(out).not.toBe("");
        expect(out).toContain("contoso");
        expect(out).toContain("fabrikam");
        expect(out).toContain("personal-acct");
        // Proves nothing is hardcoded to Microsoft's values.
        expect(out).not.toContain("microsoft");
    });

    it("distinguishes a present-but-untrusted claim value (not 'missing')", () => {
        const log =
            "AADSTS7002381: ... must contain the enterprise claim with value " +
            "'microsoft' or 'github' but actual value is 'fabrikam'.";
        const out = explainOidcEnterpriseClaim(log);
        expect(out).not.toBe("");
        // The claim IS present, just not trusted — must not say it's "missing".
        expect(out).toContain("not trusted");
        expect(out).toContain("fabrikam");
        expect(out).not.toContain("missing");
    });

    it("returns '' for an unrelated error", () => {
        expect(explainOidcEnterpriseClaim("some unrelated error: forbidden")).toBe("");
    });

    it("falls back to a generic accepted label and 'not reported' when only the AADSTS code is present", () => {
        const log = "Login failed: AADSTS7002381 was returned by the token endpoint.";
        const out = explainOidcEnterpriseClaim(log);
        expect(out).not.toBe("");
        expect(out).toContain("a value required by the target Azure tenant");
        // Actual value was not parseable — don't assert a definite empty/personal value.
        expect(out).toContain("not reported");
        expect(out).not.toContain("missing");
        expect(out).not.toContain("empty (this repository");
    });

    it("returns '' for empty / undefined input", () => {
        expect(explainOidcEnterpriseClaim("")).toBe("");
        expect(explainOidcEnterpriseClaim(undefined)).toBe("");
        expect(explainOidcEnterpriseClaim(null)).toBe("");
    });
});

describe("extractErrorLines", () => {
    it("returns trailing error-ish lines only", () => {
        const log = [
            "starting up",
            "everything is fine",
            "Error: something exploded",
            "cleanup done",
            "fatal: giving up",
        ].join("\n");
        const out = extractErrorLines(log, 8);
        expect(out).toContain("Error: something exploded");
        expect(out).toContain("fatal: giving up");
        expect(out).not.toContain("everything is fine");
    });

    it("returns [] for empty input", () => {
        expect(extractErrorLines("")).toEqual([]);
        expect(extractErrorLines(undefined)).toEqual([]);
    });
});
describe("explainRepoAccessForEnvSetup", () => {
    it("read failure with a known login → switch-account guidance", () => {
        const out = explainRepoAccessForEnvSetup({
            repo: "azure-cto/app", login: "ryanwaite", readFailed: true, permissions: null,
        });
        expect(out).not.toBe("");
        expect(out).toContain("ryanwaite");
        expect(out).toContain("azure-cto/app");
        expect(out).toContain("gh auth switch");
    });

    it("read failure with unknown login → 'the active gh account'", () => {
        const out = explainRepoAccessForEnvSetup({
            repo: "azure-cto/app", login: "", readFailed: true, permissions: null,
        });
        expect(out).toContain("the active gh account");
    });

    it("admin access → '' (no error)", () => {
        expect(explainRepoAccessForEnvSetup({
            repo: "azure-cto/app", login: "ryanwaite", readFailed: false, permissions: { admin: true },
        })).toBe("");
    });

    it("maintain-only → Admin-needed message naming the Maintain role, no switch guidance", () => {
        const out = explainRepoAccessForEnvSetup({
            repo: "azure-cto/app", login: "ryanwaite_microsoft", readFailed: false,
            permissions: { admin: false, maintain: true, push: true },
        });
        expect(out).toContain("Admin");
        expect(out).toContain("Maintain");
        expect(out).toContain("grant");
        expect(out).not.toContain("gh auth switch");
    });

    it("push-only → role label Write", () => {
        const out = explainRepoAccessForEnvSetup({
            repo: "azure-cto/app", login: "ryanwaite", readFailed: false,
            permissions: { admin: false, maintain: false, push: true },
        });
        expect(out).toContain("Write");
    });

    it("pull-only → role label Read", () => {
        const out = explainRepoAccessForEnvSetup({
            repo: "azure-cto/app", login: "ryanwaite", readFailed: false,
            permissions: { admin: false, pull: true },
        });
        expect(out).toContain("Read");
    });

    it("null permissions with read OK (odd edge) → non-empty, role undetermined, no throw", () => {
        const out = explainRepoAccessForEnvSetup({
            repo: "azure-cto/app", login: "ryanwaite", readFailed: false, permissions: null,
        });
        expect(out).not.toBe("");
        expect(out).not.toContain("no direct");
        expect(out).toContain("does not have Admin");
        expect(out).toContain("could not be determined");
    });

    it("admin missing with empty login → addresses 'you'", () => {
        const out = explainRepoAccessForEnvSetup({
            repo: "azure-cto/app", login: "", readFailed: false,
            permissions: { admin: false, pull: true },
        });
        expect(out).toContain("you");
    });
});

describe("isRepoNotFoundError", () => {
    it("is true for gh's Not Found (HTTP 404) text", () => {
        expect(isRepoNotFoundError("gh: Not Found (HTTP 404)")).toBe(true);
    });
    it("is true for a bare HTTP 404", () => {
        expect(isRepoNotFoundError("request failed: HTTP 404")).toBe(true);
    });
    it("is true for a lowercase 'not found' phrase", () => {
        expect(isRepoNotFoundError("the repository was not found")).toBe(true);
    });
    it("is false for HTTP 403", () => {
        expect(isRepoNotFoundError("gh: Forbidden (HTTP 403)")).toBe(false);
    });
    it("is false for a timeout / transient error", () => {
        expect(isRepoNotFoundError("dial tcp: i/o timeout")).toBe(false);
    });
    it("is false for empty / undefined / null", () => {
        expect(isRepoNotFoundError("")).toBe(false);
        expect(isRepoNotFoundError(undefined)).toBe(false);
        expect(isRepoNotFoundError(null)).toBe(false);
    });
});

describe("findDeployJobId", () => {
    it("returns the id of the job containing the named step", () => {
        const detail = {
            jobs: [
                { id: 111, steps: [{ name: "Checkout" }, { name: "Setup" }] },
                { id: 222, steps: [{ name: "Run rad commands" }] },
                { id: 333, steps: [{ name: "Teardown" }] },
            ],
        };
        expect(findDeployJobId(detail)).toBe(222);
    });

    it("honors a custom step name", () => {
        const detail = { jobs: [{ id: 42, steps: [{ name: "rad deploy" }] }] };
        expect(findDeployJobId(detail, "rad deploy")).toBe(42);
    });

    it("falls back to databaseId when the job carries no id", () => {
        const detail = { jobs: [{ databaseId: 555, steps: [{ name: "Run rad commands" }] }] };
        expect(findDeployJobId(detail)).toBe(555);
    });

    it("returns null when no job step matches", () => {
        const detail = { jobs: [{ id: 1, steps: [{ name: "Checkout" }] }] };
        expect(findDeployJobId(detail)).toBeNull();
    });

    it("returns null for missing / malformed detail", () => {
        expect(findDeployJobId(null)).toBeNull();
        expect(findDeployJobId({})).toBeNull();
        expect(findDeployJobId({ jobs: null })).toBeNull();
        expect(findDeployJobId({ jobs: [{ steps: null }] })).toBeNull();
    });
});

describe("parseRadDeployProgress", () => {
    // Column-oriented sample copied verbatim from the User experience section
    // of docs/design/2026-07-deployed-application-graph.md so any drift is caught.
    const SAMPLE = [
        "Building app.bicep...",
        "Deploying template 'app.bicep' for application 'todolist' and environment '/planes/radius/local/resourceGroups/my-group/providers/applications.core/environments/my-env' from workspace 'my-workspace'...",
        "",
        "Deployment In Progress...",
        "",
        "Completed            todolist        Applications.Core/applications",
        "Completed            postgresql      Radius.Data/postgreSqlDatabases",
        "Completed            frontend        Applications.Core/containers",
        "",
        "Deployment Complete",
        "",
        "Resources:",
        "   todolist        Applications.Core/applications",
        "   frontend        Applications.Core/containers",
        "   postgresql      Radius.Data/postgreSqlDatabases",
    ].join("\n");

    const modeled = [
        { name: "todolist", type: "Applications.Core/applications" },
        { name: "postgresql", type: "Radius.Data/postgreSqlDatabases" },
        { name: "frontend", type: "Applications.Core/containers" },
    ];

    it("maps each Completed line to success and reports the global 'complete' marker", () => {
        const out = parseRadDeployProgress(SAMPLE, modeled);
        expect(out.global).toBe("complete");
        expect(out.byName).toEqual({
            todolist: "success",
            postgresql: "success",
            frontend: "success",
        });
    });

    it("reports global in_progress before any Completed line", () => {
        const partial = ["Deployment In Progress...", ""].join("\n");
        const out = parseRadDeployProgress(partial, modeled);
        expect(out.global).toBe("in_progress");
        expect(out.byName).toEqual({});
    });

    it("maps a Failed line to failed", () => {
        const log = [
            "Deployment In Progress...",
            "Completed            frontend        Applications.Core/containers",
            "Failed               postgresql      Radius.Data/postgreSqlDatabases",
        ].join("\n");
        const out = parseRadDeployProgress(log, modeled);
        expect(out.byName.frontend).toBe("success");
        expect(out.byName.postgresql).toBe("failed");
    });

    it("ignores unknown status keywords", () => {
        const log = "Provisioning         frontend        Applications.Core/containers";
        const out = parseRadDeployProgress(log, modeled);
        expect(out.byName).toEqual({});
        expect(out.global).toBeNull();
    });

    it("ignores a resource name that is not in the modeled list", () => {
        const log = "Completed            unknown         Applications.Core/containers";
        const out = parseRadDeployProgress(log, modeled);
        expect(out.byName).toEqual({});
    });

    it("tolerates the `gh api /jobs/{id}/logs` ISO timestamp prefix on each line", () => {
        const log = [
            "2026-07-29T12:00:00.0000000Z Deployment In Progress...",
            "2026-07-29T12:00:05.1234567Z Completed            frontend        Applications.Core/containers",
        ].join("\n");
        const out = parseRadDeployProgress(log, modeled);
        expect(out.global).toBe("in_progress");
        expect(out.byName.frontend).toBe("success");
    });

    it("tolerates the `<job>\\t<step>\\t<timestamp>` prefix from `gh run view --log`", () => {
        // Real format captured from a failed run: the job name carries spaces so
        // we can't split on whitespace — we strip on tabs then the timestamp.
        const log = [
            "Azure / Deploy with Radius\tRun rad commands\t2026-07-29T22:20:39.1395328Z Deployment In Progress...",
            "Azure / Deploy with Radius\tRun rad commands\t2026-07-29T22:21:10.0756405Z Completed            frontend        Applications.Core/containers",
            "Azure / Deploy with Radius\tRun rad commands\t2026-07-29T22:21:10.0757000Z Failed               postgresql      Radius.Data/postgreSqlDatabases",
        ].join("\n");
        const out = parseRadDeployProgress(log, modeled);
        expect(out.global).toBe("in_progress");
        expect(out.byName.frontend).toBe("success");
        expect(out.byName.postgresql).toBe("failed");
    });

    it("returns an empty result for empty / missing input", () => {
        expect(parseRadDeployProgress("", modeled)).toEqual({ global: null, byName: {} });
        expect(parseRadDeployProgress(null, modeled)).toEqual({ global: null, byName: {} });
        expect(parseRadDeployProgress(undefined, modeled)).toEqual({ global: null, byName: {} });
    });

    it("survives a modeled list with no names without throwing", () => {
        const log = "Completed            frontend        Applications.Core/containers";
        expect(parseRadDeployProgress(log, [])).toEqual({ global: null, byName: {} });
        expect(parseRadDeployProgress(log, null)).toEqual({ global: null, byName: {} });
    });
});

describe("extractAppGraphJson", () => {
    // A `rad app graph <app>` response inlined in the job log after the
    // `Deployment Complete` block. Shape mirrors what applicationGraphToResources
    // consumes (id, name, type, connections, outputResources).
    const APP_GRAPH = {
        resources: [
            { id: "app/todolist", name: "todolist", type: "Applications.Core/applications", connections: [], outputResources: [] },
            { id: "app/frontend", name: "frontend", type: "Applications.Core/containers", connections: [{ id: "app/postgresql", direction: "Outbound" }], outputResources: [] },
            { id: "app/postgresql", name: "postgresql", type: "Radius.Data/postgreSqlDatabases", connections: [], outputResources: [] },
        ],
    };

    it("returns the ApplicationGraphResponse at the tail of the job log", () => {
        const log = [
            "Building app.bicep...",
            "Deployment In Progress...",
            "Completed            frontend        Applications.Core/containers",
            "Deployment Complete",
            "",
            "Resources:",
            "   frontend        Applications.Core/containers",
            "",
            JSON.stringify(APP_GRAPH),
        ].join("\n");
        const parsed = extractAppGraphJson(log);
        expect(parsed).toEqual(APP_GRAPH);
    });

    it("prefers the trailing rad-app-graph JSON over an earlier rad Error block", () => {
        const errorBlock = 'Error: { "code": "X", "message": "y" }';
        const log = [
            "Deployment In Progress...",
            errorBlock,
            "Completed            frontend        Applications.Core/containers",
            "Deployment Complete",
            JSON.stringify(APP_GRAPH),
        ].join("\n");
        const parsed = extractAppGraphJson(log);
        expect(parsed).toEqual(APP_GRAPH);
    });

    it("returns null for a log with no top-level JSON object at the tail", () => {
        const log = [
            "Deployment In Progress...",
            "Completed            frontend        Applications.Core/containers",
            "Deployment Complete",
            "Resources:",
            "   frontend        Applications.Core/containers",
        ].join("\n");
        expect(extractAppGraphJson(log)).toBeNull();
    });

    it("returns null when the trailing JSON candidate is not well-formed", () => {
        const log = [
            "Deployment Complete",
            "{ \"resources\": [ { unterminated",
        ].join("\n");
        expect(extractAppGraphJson(log)).toBeNull();
    });

    it("ignores JSON that is not an ApplicationGraphResponse (missing resources array)", () => {
        // A trailing object without a `.resources` array must be skipped so we
        // never mistake a random JSON log line for the deployed graph.
        const log = ["Deployment Complete", JSON.stringify({ foo: "bar" })].join("\n");
        expect(extractAppGraphJson(log)).toBeNull();
    });

    it("returns null for empty / missing input", () => {
        expect(extractAppGraphJson("")).toBeNull();
        expect(extractAppGraphJson(null)).toBeNull();
        expect(extractAppGraphJson(undefined)).toBeNull();
    });
});
