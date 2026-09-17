import {
  nameSchema,
  portCancelled,
  portFailure,
  portSuccess,
  portUnavailable,
  sameLifecycleData,
  type ApplicationInspection,
  type ApplicationPage,
  type ApplicationReadPort,
  type AuthorizedScope,
  type ClockPort,
  type PortResult,
  type ReadResult,
  type RequestControl,
  type SourceSelection,
  type SourceOperation
} from "@radius-project/core/lifecycle";
import type { SourceReadAdapter } from "./source-access.js";

export interface ApplicationReadDependencies {
  source: Pick<SourceReadAdapter, "capture" | "readText" | "releaseSnapshot">;
  clock: Pick<ClockPort, "now">;
  extractAppName(text: string): string;
  resolveSelection(
    scope: AuthorizedScope<"application.list">,
    definition: string | undefined,
    control: RequestControl
  ): Promise<ReadResult<SourceSelection>>;
  deployed(
    scope: AuthorizedScope<"application.list" | "application.inspect">,
    control: RequestControl
  ): Promise<PortResult<Pick<ApplicationPage, "items" | "observation">>>;
}

export function createApplicationReadAdapter(
  deps: ApplicationReadDependencies
): ApplicationReadPort {
  if (
    [
      deps?.source?.capture,
      deps?.source?.readText,
      deps?.source?.releaseSnapshot,
      deps?.clock?.now,
      deps?.extractAppName,
      deps?.deployed,
      deps?.resolveSelection
    ].some((method) => typeof method !== "function")
  )
    throw new Error(
      "Application reads require source, name, deployed evidence and clock ports."
    );
  const validName = new RegExp(nameSchema.pattern);
  async function authored(
    scope: AuthorizedScope<SourceOperation>,
    selection: SourceSelection,
    control: RequestControl
  ): Promise<ReadResult<ApplicationInspection>> {
    const capture = await deps.source.capture(scope, selection, control);
    if (capture.status !== "ok") return capture;
    if (capture.value.status !== "captured")
      return portUnavailable(
        "SOURCE_UNAVAILABLE",
        {
          quality: "unknown",
          completeness: "partial",
          evidence: "source",
          limitation:
            "The effective source input closure could not be established."
        },
        { diagnostics: capture.value.manifest.diagnostics }
      );
    const { snapshot } = capture.value;
    let result: ReadResult<ApplicationInspection>;
    try {
      if (!sameLifecycleData(snapshot.selection, selection))
        throw new Error("Mismatched source selection");
      const text = await deps.source.readText(
        snapshot,
        selection.definition,
        control
      );
      if (text.status !== "ok") result = text;
      else {
        const name = deps.extractAppName(text.value.text);
        if (
          !name ||
          name.length > nameSchema.maxLength ||
          !validName.test(name)
        )
          result = portUnavailable("RESULT_UNAVAILABLE", {
            quality: "unknown",
            completeness: "partial",
            evidence: "source",
            limitation:
              "The application name is not a supported static declaration."
          });
        else {
          const observation = {
            quality: "current" as const,
            completeness: "complete" as const,
            evidence: "source" as const,
            observedAt: snapshot.provenance.resolvedAt
          };
          result = portSuccess({
            target: { repo: selection.repo, application: name },
            authored: {
              provenance: { ...snapshot.provenance },
              definition: selection.definition,
              observation
            },
            observation
          });
        }
      }
    } catch {
      result = portUnavailable("SOURCE_UNAVAILABLE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "source"
      });
    }
    const cleanup = await deps.source.releaseSnapshot(snapshot);
    if (cleanup.status !== "ok") return cleanup;
    return control.cancellation.aborted ?
        portCancelled("request_cancelled")
      : result;
  }
  return {
    async inspect(scope, control) {
      const target = scope.target;
      let selected: ApplicationInspection | undefined;
      if ("source" in target) {
        const result = await authored(
          scope,
          {
            repo: target.repo,
            source: target.source,
            definition: target.definition
          },
          control
        );
        if (result.status !== "ok") return result;
        if (result.value.target.application !== target.application)
          return portFailure("EVIDENCE_MISMATCH");
        selected = result.value;
      }
      if ("environment" in target) {
        const deployed = await deps.deployed(scope, control);
        if (
          deployed.status !== "ok" &&
          (!selected ||
            deployed.status === "forbidden" ||
            deployed.status === "cancelled")
        )
          return deployed;
        const match =
          deployed.status === "ok" ?
            deployed.value.items.find(
              (item) => item.target.application === target.application
            )
          : undefined;
        if (match)
          selected =
            selected ?
              {
                ...selected,
                deployed: match.deployed,
                observation: {
                  ...selected.observation,
                  completeness: "partial",
                  limitation:
                    "Authored and deployed evidence have independent observation times."
                }
              }
            : match;
        else if (selected)
          selected = {
            ...selected,
            deployed: [
              {
                environment: target.environment,
                observation: {
                  quality: "unknown",
                  completeness: "unavailable",
                  evidence: "workflow",
                  limitation: "Deployed evidence could not be observed."
                }
              }
            ],
            observation: {
              ...selected.observation,
              completeness: "partial",
              limitation: "Deployed evidence could not be observed."
            }
          };
      }
      return selected ?
          portSuccess(selected)
        : portUnavailable("RESULT_UNAVAILABLE", {
            quality: "unknown",
            completeness: "unavailable",
            evidence: "workflow",
            limitation:
              "No supported deployed observation identifies the selected application."
          });
    },
    async list(scope, input, control) {
      const items: ApplicationInspection[] = [];
      let deployedObservation: ApplicationPage["observation"] | undefined;
      if (!input.source && !scope.target.environment) {
        for (const definition of input.definition ?
          [input.definition]
        : [".radius/app.bicep", "app.bicep"]) {
          const selected = await deps.resolveSelection(
            scope,
            definition,
            control
          );
          if (selected.status === "ok") {
            if (selected.value.definition !== definition)
              return portFailure("EVIDENCE_MISMATCH");
            const result = await authored(scope, selected.value, control);
            if (result.status !== "ok")
              return result.status === "absent" ?
                  portFailure("SOURCE_CHANGED")
                : result;
            items.push(result.value);
          } else if (selected.status !== "absent") return selected;
        }
      } else if (input.source) {
        if (input.source.kind === "workspace" && !input.definition)
          return portFailure("INVALID_REQUEST");
        const definitions =
          input.definition ?
            [input.definition]
          : [".radius/app.bicep", "app.bicep"];
        for (const definition of definitions) {
          const result = await authored(
            scope,
            { repo: scope.target.repo, source: input.source, definition },
            control
          );
          if (result.status === "absent") continue;
          if (result.status !== "ok") return result;
          items.push(result.value);
        }
      }
      if (scope.target.environment) {
        const result = await deps.deployed(scope, control);
        if (result.status !== "ok") return result;
        items.push(...result.value.items);
        deployedObservation = result.value.observation;
      }
      const page: ApplicationPage = {
        target: { ...scope.target },
        items,
        observation: {
          quality: "current",
          completeness:
            !input.definition && !scope.target.environment ?
              "partial"
            : "complete",
          evidence:
            input.source || !scope.target.environment ? "source" : "workflow",
          observedAt: deps.clock.now(),
          ...(!input.definition && !scope.target.environment ?
            {
              limitation:
                "Only the two canonical definitions (.radius/app.bicep, then app.bicep) are searched; select other definitions explicitly. Recursive application discovery is unavailable."
            }
          : {})
        }
      };
      if (deployedObservation && !input.source)
        page.observation = { ...deployedObservation };
      return portSuccess(page);
    }
  };
}
