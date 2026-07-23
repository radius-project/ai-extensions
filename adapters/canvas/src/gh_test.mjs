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
});
