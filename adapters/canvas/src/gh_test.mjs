import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
    execFile: vi.fn(),
    execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => childProcess);

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform) {
    Object.defineProperty(process, "platform", {
        configurable: true,
        value: platform,
    });
}

async function loadGh(platform, keyringToken = "") {
    setPlatform(platform);
    childProcess.execFileSync.mockReturnValue(Buffer.from(keyringToken));
    vi.resetModules();
    return import("./gh.mjs");
}

describe.sequential("cliExec", () => {
    beforeEach(() => {
        childProcess.execFile.mockReset();
        childProcess.execFileSync.mockReset();
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", platformDescriptor);
    });

    it("passes a Windows gh query string containing an ampersand as one literal argument", async () => {
        const { cliExec } = await loadGh("win32");
        const callback = vi.fn();
        const apiPath = "/repos/acme/widgets/deployments?environment=test&per_page=10";

        cliExec("gh", ["api", apiPath, "--jq", ".[].id"], {}, callback);

        expect(childProcess.execFile).toHaveBeenCalledOnce();
        const [file, args, options, receivedCallback] = childProcess.execFile.mock.calls[0];
        expect(file).toBe("gh.exe");
        expect(args).toEqual(["api", apiPath, "--jq", ".[].id"]);
        expect(args[1]).toBe(apiPath);
        expect(options.windowsHide).toBe(true);
        expect(receivedCallback).toBe(callback);
    });

    it("keeps normal non-Windows gh invocation behavior", async () => {
        const { cliExec } = await loadGh("linux");
        const callback = vi.fn();

        cliExec("gh", ["repo", "view", "acme/widgets"], { timeout: 1000 }, callback);

        expect(childProcess.execFile).toHaveBeenCalledWith(
            "gh",
            ["repo", "view", "acme/widgets"],
            expect.objectContaining({ timeout: 1000, windowsHide: true }),
            callback,
        );
    });

    it("treats 'gh.exe' as a gh invocation on Windows (no cmd.exe wrapper)", async () => {
        const { cliExec } = await loadGh("win32");
        const callback = vi.fn();
        const apiPath = "/repos/acme/widgets/deployments?environment=test&per_page=10";

        cliExec("gh.exe", ["api", apiPath, "--jq", ".[].id"], {}, callback);

        const [file, args] = childProcess.execFile.mock.calls[0];
        expect(file).toBe("gh.exe");
        expect(args).toEqual(["api", apiPath, "--jq", ".[].id"]);
    });

    it("treats a full path to gh.exe as a gh invocation on Windows (no cmd.exe wrapper)", async () => {
        const { cliExec } = await loadGh("win32");
        const callback = vi.fn();

        cliExec("C:\\Program Files\\gh\\bin\\gh.exe", ["auth", "status"], {}, callback);

        const [file, args] = childProcess.execFile.mock.calls[0];
        expect(file).toBe("gh.exe");
        expect(args).toEqual(["auth", "status"]);
    });

    it("strips ambient tokens for a full-path gh invocation", async () => {
        const { cliExec } = await loadGh("linux", "stored-token\n");
        const callback = vi.fn();

        cliExec("/usr/local/bin/gh", ["auth", "status"], {
            env: { GH_TOKEN: "tok", KEEP_ME: "yes" },
        }, callback);

        const [, , options] = childProcess.execFile.mock.calls[0];
        expect(options.env).toEqual({ KEEP_ME: "yes" });
    });

    it("retains the Windows cmd wrapper for non-gh CLIs", async () => {
        const { cliExec } = await loadGh("win32");
        const callback = vi.fn();

        cliExec("az", ["account", "show"], {}, callback);

        expect(childProcess.execFile).toHaveBeenCalledWith(
            "cmd.exe",
            ["/c", "az", "account", "show"],
            expect.objectContaining({ windowsHide: true }),
            callback,
        );
    });

    it("removes ambient GitHub tokens when a keyring login exists", async () => {
        const { cliExec } = await loadGh("win32", "stored-token\n");
        const callback = vi.fn();

        cliExec("gh", ["auth", "status"], {
            env: {
                GH_TOKEN: "ambient-gh",
                GITHUB_TOKEN: "ambient-github",
                KEEP_ME: "yes",
            },
        }, callback);

        expect(childProcess.execFile).toHaveBeenCalledWith(
            "gh.exe",
            ["auth", "status"],
            expect.objectContaining({ env: { KEEP_ME: "yes" } }),
            callback,
        );
    });

    it("preserves ambient GitHub tokens when no keyring login exists", async () => {
        const { cliExec } = await loadGh("win32");
        const callback = vi.fn();

        cliExec("gh", ["auth", "status"], {
            env: {
                GH_TOKEN: "ambient-gh",
                GITHUB_TOKEN: "ambient-github",
            },
        }, callback);

        expect(childProcess.execFile).toHaveBeenCalledWith(
            "gh.exe",
            ["auth", "status"],
            expect.objectContaining({
                env: {
                    GH_TOKEN: "ambient-gh",
                    GITHUB_TOKEN: "ambient-github",
                },
            }),
            callback,
        );
    });

    it("strips COPILOT_AGENT_SESSION_ID from a non-gh (az) child env while preserving PATH", async () => {
        const { cliExec } = await loadGh("linux");
        const callback = vi.fn();
        const saved = process.env.COPILOT_AGENT_SESSION_ID;
        process.env.COPILOT_AGENT_SESSION_ID = "test-session-id";
        try {
            cliExec("az", ["account", "show"], {}, callback);
        } finally {
            if (saved === undefined) delete process.env.COPILOT_AGENT_SESSION_ID;
            else process.env.COPILOT_AGENT_SESSION_ID = saved;
        }

        const [, , options] = childProcess.execFile.mock.calls[0];
        expect(options.env.COPILOT_AGENT_SESSION_ID).toBeUndefined();
        expect(options.env.PATH).toBe(process.env.PATH);
    });

    it("strips COPILOT_AGENT_SESSION_ID on the gh path (on top of ghChildEnv)", async () => {
        const { cliExec } = await loadGh("linux", "stored-token\n");
        const callback = vi.fn();

        cliExec("gh", ["auth", "status"], {
            env: {
                GH_TOKEN: "ambient-gh",
                COPILOT_AGENT_SESSION_ID: "test-session-id",
                KEEP_ME: "yes",
            },
        }, callback);

        const [, , options] = childProcess.execFile.mock.calls[0];
        // ghChildEnv strips GH_TOKEN (keyring login present); withoutAgentSession
        // strips the agent session var; KEEP_ME survives.
        expect(options.env).toEqual({ KEEP_ME: "yes" });
        expect(options.env.COPILOT_AGENT_SESSION_ID).toBeUndefined();
    });

    it("produces a valid env with PATH when COPILOT_AGENT_SESSION_ID is unset", async () => {
        const { cliExec } = await loadGh("linux");
        const callback = vi.fn();
        const saved = process.env.COPILOT_AGENT_SESSION_ID;
        delete process.env.COPILOT_AGENT_SESSION_ID;
        try {
            cliExec("az", ["account", "show"], {}, callback);
        } finally {
            if (saved !== undefined) process.env.COPILOT_AGENT_SESSION_ID = saved;
        }

        const [, , options] = childProcess.execFile.mock.calls[0];
        expect(options.env).toBeTypeOf("object");
        expect(options.env.PATH).toBe(process.env.PATH);
        expect(options.env.COPILOT_AGENT_SESSION_ID).toBeUndefined();
    });
});

describe.sequential("ghApiJson", () => {
    beforeEach(() => {
        childProcess.execFile.mockReset();
        childProcess.execFileSync.mockReset();
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", platformDescriptor);
    });

    const stubChild = () => ({ stdin: { end() {} } });

    it("parses a successful JSON body as ok/200", async () => {
        const { ghApiJson } = await loadGh("linux");
        childProcess.execFile.mockImplementation((file, args, opts, cb) => {
            cb(null, '{"full_name":"o/r"}', "");
            return stubChild();
        });
        const res = await ghApiJson("/repos/o/r");
        expect(res).toEqual({ ok: true, status: 200, json: { full_name: "o/r" }, stderr: "" });
    });

    it("extracts an HTTP status from gh stderr on failure", async () => {
        const { ghApiJson } = await loadGh("linux");
        childProcess.execFile.mockImplementation((file, args, opts, cb) => {
            cb(new Error("gh: exit 1"), "", "gh: Not Found (HTTP 404)");
            return stubChild();
        });
        const res = await ghApiJson("/repos/o/missing");
        expect(res.ok).toBe(false);
        expect(res.status).toBe(404);
        expect(res.stderr).toContain("404");
    });

    it("returns a null status when no HTTP code is present (transport error)", async () => {
        const { ghApiJson } = await loadGh("linux");
        childProcess.execFile.mockImplementation((file, args, opts, cb) => {
            cb(new Error("ECONNRESET"), "", "ECONNRESET");
            return stubChild();
        });
        const res = await ghApiJson("/x");
        expect(res.status).toBe(null);
        expect(res.ok).toBe(false);
    });

    it("reports a JSON parse failure as not-ok with status 200", async () => {
        const { ghApiJson } = await loadGh("linux");
        childProcess.execFile.mockImplementation((file, args, opts, cb) => {
            cb(null, "not json", "");
            return stubChild();
        });
        const res = await ghApiJson("/x");
        expect(res.ok).toBe(false);
        expect(res.status).toBe(200);
        expect(res.stderr).toMatch(/failed to parse/);
    });

    it("passes custom headers through as -H args", async () => {
        const { ghApiJson } = await loadGh("linux");
        childProcess.execFile.mockImplementation((file, args, opts, cb) => {
            cb(null, "null", "");
            return stubChild();
        });
        await ghApiJson("/x", { headers: { "X-GitHub-Api-Version": "2022-11-28" } });
        const [, args] = childProcess.execFile.mock.calls[0];
        expect(args).toEqual(["api", "/x", "-H", "X-GitHub-Api-Version: 2022-11-28"]);
    });
});
