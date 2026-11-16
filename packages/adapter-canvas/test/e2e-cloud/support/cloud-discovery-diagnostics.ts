import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response, Route, TestInfo } from "@playwright/test";
import { boundedDiagnostic } from "../../../src/command-failure.js";
import type { CanvasTarget } from "./copilot-app-ui.js";
import { pageOf } from "./copilot-app-ui.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      Object.fromEntries(Object.entries(value))
    : {};
}

export function createCloudDiscoveryDiagnostics(
  context: {
    testTitle: string;
    retry: number;
  },
  ports: {
    now(): Date;
    snapshot(): Promise<unknown>;
    save(body: string): Promise<void>;
    credentials: readonly (string | undefined)[];
  }
) {
  const events: { at: string; kind: string; details: unknown }[] = [];
  let droppedEvents = 0;
  let firstFailure: Promise<Error> | undefined;
  let signalFailure: (error: Error) => void = () => {};
  const failure = new Promise<Error>((resolve) => {
    signalFailure = resolve;
  });
  const safeText = (value: string): string =>
    boundedDiagnostic(value, ports.credentials);
  const safeDetails = (details: unknown): unknown =>
    JSON.parse(
      JSON.stringify(details, (_key, value: unknown) =>
        typeof value === "string" ? safeText(value) : value
      )
    ) as unknown;
  const snapshot = async (): Promise<unknown> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return safeDetails(
        await Promise.race([
          ports.snapshot(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "Failure snapshot exceeded the 5-second capture limit."
                  )
                ),
              5000
            );
          })
        ])
      );
    } finally {
      clearTimeout(timeout);
    }
  };
  const protectedKinds = ["first-failure", "failure-snapshot", "capture-error"];
  const add = (kind: string, details: unknown): void => {
    if (events.length >= 64) {
      droppedEvents++;
      if (!protectedKinds.includes(kind)) return;
      // First-failure evidence may displace capture errors, never the reverse.
      const replace = events.findIndex(
        (event) => !protectedKinds.includes(event.kind)
      );
      const fallback =
        kind === "capture-error" ? -1 : (
          events.findIndex((event) => event.kind === "capture-error")
        );
      const index = replace >= 0 ? replace : fallback;
      if (index < 0) return;
      events.splice(index, 1);
    }
    events.push({
      at: ports.now().toISOString(),
      kind,
      details: safeDetails(details)
    });
  };
  const fail = (
    message: string,
    evidence?: unknown,
    beforeRequest?: unknown
  ): Promise<Error> => {
    firstFailure ??= (async () => {
      add("first-failure", { error: message, evidence, beforeRequest });
      let captureFailure = "";
      try {
        add("failure-snapshot", { beforeRequest, atFailure: await snapshot() });
      } catch (error) {
        captureFailure = `; failure snapshot capture failed: ${safeText(error instanceof Error ? error.message : String(error))}`;
        add("capture-error", {
          stage: "failure-snapshot",
          error: error instanceof Error ? error.message : String(error)
        });
      }
      const error = new Error(
        `Cloud discovery failed: ${safeText(message)}${captureFailure}`
      );
      signalFailure(error);
      return error;
    })();
    return firstFailure;
  };
  return {
    async requestSnapshot(): Promise<unknown> {
      try {
        return await snapshot();
      } catch (error) {
        const detail = {
          stage: "request-snapshot",
          error: error instanceof Error ? error.message : String(error)
        };
        add("capture-error", detail);
        return safeDetails(detail);
      }
    },
    async discovery(payload: unknown, beforeRequest?: unknown): Promise<void> {
      const data = record(payload);
      const diagnostics = record(data.diagnostics);
      const errors = Object.fromEntries(
        ["clusters", "resourceGroups", "namespaces", "vpcs", "subnets"]
          .filter((key) => typeof record(data.errors)[key] === "string")
          .map((key) => [key, record(data.errors)[key]])
      );
      const evidence = {
        commands:
          Array.isArray(diagnostics.events) ?
            diagnostics.events.slice(0, 16).map((value: unknown) => {
              const event = record(value);
              return Object.fromEntries(
                [
                  "step",
                  "startedAt",
                  "durationMs",
                  "timeoutMs",
                  "exitCode",
                  "signal",
                  "timedOut",
                  "error"
                ].map((key) => {
                  const value = event[key];
                  return [
                    key,
                    (
                      value === null ||
                      typeof value === "string" ||
                      typeof value === "number" ||
                      typeof value === "boolean"
                    ) ?
                      value
                    : undefined
                  ];
                })
              );
            })
          : [],
        errors,
        error: typeof data.error === "string" ? data.error : undefined,
        namespaces:
          Array.isArray(data.namespaces) ?
            data.namespaces
              .filter((value): value is string => typeof value === "string")
              .slice(0, 100)
          : []
      };
      add("discovery", evidence);
      const messages = [data.error, ...Object.values(errors)].filter(
        (value): value is string => typeof value === "string" && value !== ""
      );
      if (messages.length)
        await fail(messages.join("; "), evidence, beforeRequest);
      else if (!Array.isArray(diagnostics.events))
        await fail(
          "Discovery response has no command diagnostics.",
          evidence,
          beforeRequest
        );
    },
    captureError: async (error: unknown): Promise<void> => {
      const message = error instanceof Error ? error.message : String(error);
      add("capture-error", { stage: "response", error: message });
      await fail(`Diagnostic capture failed: ${message}`);
    },
    async guard<T>(action: () => Promise<T>): Promise<T> {
      if (firstFailure) throw await firstFailure;
      const result = await Promise.race([
        action(),
        failure.then((error) => {
          throw error;
        })
      ]);
      // The action can finish while the failure snapshot is still captured.
      if (firstFailure) throw await firstFailure;
      return result;
    },
    async save(): Promise<void> {
      await firstFailure;
      await ports.save(
        JSON.stringify(
          { ...context, droppedEvents, events },
          (_key, value: unknown) =>
            typeof value === "string" ? safeText(value) : value,
          2
        )
      );
    }
  };
}

export async function observeCloudDiscovery(
  target: CanvasTarget,
  testInfo: TestInfo,
  credentials: readonly (string | undefined)[]
) {
  const page = pageOf(target);
  const observer = createCloudDiscoveryDiagnostics(
    {
      testTitle: testInfo.title,
      retry: testInfo.retry
    },
    {
      now: () => new Date(),
      credentials,
      snapshot: () =>
        target.evaluate(() => {
          const selectors = [
            "azure-rg-select",
            "azure-cluster-select",
            "azure-namespace-select"
          ].map((id) => {
            const element = document.getElementById(id);
            return element instanceof HTMLSelectElement ?
                {
                  id,
                  value: element.value,
                  disabled: element.disabled,
                  hidden: element.hidden,
                  options: Array.from(element.options)
                    .slice(0, 100)
                    .map((option) => ({
                      value: option.value,
                      label: option.label,
                      selected: option.selected,
                      disabled: option.disabled
                    }))
                }
              : { id, missing: true };
          });
          const custom = document.getElementById("azure-namespace-custom");
          return {
            selectors,
            customNamespace:
              custom instanceof HTMLInputElement ?
                {
                  value: custom.value,
                  hidden: custom.hidden,
                  display: custom.style.display,
                  disabled: custom.disabled
                }
              : null
          };
        }),
      save: async (body) => {
        const directory = await mkdtemp(testInfo.outputPath("discovery-"));
        const file = path.join(directory, "cloud-discovery-diagnostics.json");
        await writeFile(file, body, "utf8");
        await testInfo.attach("cloud-discovery-diagnostics", {
          path: file,
          contentType: "application/json"
        });
      }
    }
  );
  const pending = new Set<Promise<void>>();
  const beforeRequests = new WeakMap<Request, unknown>();
  const onResponse = (response: Response): void => {
    const url = new URL(response.url());
    if (url.pathname !== "/api/discover") return;
    if (
      response.request().frame() !==
      (target === page ? page.mainFrame() : target)
    )
      return;
    const task = (async () => {
      try {
        const payload: unknown = await response.json();
        await observer.discovery(
          payload,
          beforeRequests.get(response.request())
        );
      } catch (error) {
        await observer.captureError(error);
      }
    })();
    pending.add(task);
    void task.then(() => pending.delete(task));
  };
  const pattern = "**/api/discover";
  const route = async (request: Route): Promise<void> => {
    if (
      request.request().frame() !==
      (target === page ? page.mainFrame() : target)
    ) {
      await request.fallback();
      return;
    }
    beforeRequests.set(request.request(), await observer.requestSnapshot());
    await request.fallback({
      headers: {
        ...request.request().headers(),
        "x-radius-discovery-diagnostics": "1"
      }
    });
  };
  await page.route(pattern, route);
  page.on("response", onResponse);
  let disposal: Promise<void> | undefined;
  return {
    guard: observer.guard,
    dispose(): Promise<void> {
      disposal ??= (async () => {
        page.off("response", onResponse);
        try {
          await page.unroute(pattern, route);
          await Promise.all(pending);
        } finally {
          await observer.save();
        }
      })();
      return disposal;
    }
  };
}
