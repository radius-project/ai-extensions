// Does the pinned baseline still describe a valid Radius application?
//
// The clean-slate check proves the *product* created nothing yet. This proves
// the other half of the premise: that the commit the run starts from is still a
// model the product could plausibly deploy. Without it, a baseline whose
// `app.bicep` stopped compiling would surface in layer 4 as a journey failure
// somewhere far from the cause, and the fixture repository would be the last
// place anyone looked.
//
// The evaluation is pure and takes both halves as ports, so every outcome —
// each file missing, a listing that fails, a compile that fails, a compile that
// warns — is provable without a network call or a bicep binary.
import { REQUIRED_STAGED_FILES } from "@radius-project/core/modeling";
import path from "node:path";

/** The result of compiling the baseline's `app.bicep`. */
export interface BaselineCompileResult {
  readonly ok: boolean;
  /** Compiler output explaining a failure, or warnings from a success. */
  readonly diagnostics: readonly string[];
}

export interface BaselineConformancePorts {
  /** File names present in the baseline's staged model directory. */
  listBaselineFiles(): Promise<readonly string[]>;
  compileBaseline(): Promise<BaselineCompileResult>;
}

export interface BaselineConformanceResult {
  readonly ok: boolean;
  readonly missingFiles: readonly string[];
  readonly compiled: boolean;
  readonly diagnostics: readonly string[];
  /** A single reviewable explanation, empty when the baseline conforms. */
  readonly summary: string;
}

export interface BaselineWorkspaceCompilePorts {
  readTextFile(path: string): Promise<string>;
  buildGraph(
    content: string,
    definitionFile: string,
    options: {
      readonly log: (message: string) => void;
      readonly radArtifactsDir: string;
    }
  ): Promise<readonly unknown[]>;
}

/**
 * Compiles the checked-out baseline with its committed `.radius` artifacts.
 *
 * Passing `radArtifactsDir` is essential: it makes `buildGraphViaRad` consume
 * the repository's own bicepconfig.json and local extension artifacts instead
 * of deriving a fallback config that the real journey would never use.
 */
export async function compileBaselineWorkspace(
  workspacePath: string,
  radiusDirectory: string,
  ports: BaselineWorkspaceCompilePorts
): Promise<BaselineCompileResult> {
  const diagnostics: string[] = [];
  const radArtifactsDir = path.join(workspacePath, radiusDirectory);
  const definitionFile = `${radiusDirectory.replace(/\\/g, "/")}/app.bicep`;
  try {
    const content = await ports.readTextFile(
      path.join(radArtifactsDir, "app.bicep")
    );
    const resources = await ports.buildGraph(content, definitionFile, {
      log: (message) => diagnostics.push(message),
      radArtifactsDir
    });
    if (resources.length === 0)
      return {
        ok: false,
        diagnostics: [...diagnostics, "The baseline compiled to no resources."]
      };
    return { ok: true, diagnostics };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        ...diagnostics,
        error instanceof Error ? error.message : String(error)
      ]
    };
  }
}

/**
 * Checks the pinned baseline carries every required staged file and compiles.
 *
 * The required set is imported from `@radius-project/core` rather than restated
 * so a change to what the product stages cannot drift away from what the
 * fixture repository is required to contain.
 */
export async function evaluateBaselineConformance(
  ports: BaselineConformancePorts
): Promise<BaselineConformanceResult> {
  const present = new Set(await ports.listBaselineFiles());
  const missingFiles = REQUIRED_STAGED_FILES.filter(
    (file) => !present.has(file)
  );

  // A baseline missing `app.bicep` cannot be compiled at all, and attempting it
  // would report a confusing "file not found" in place of the real answer.
  if (missingFiles.length > 0)
    return {
      ok: false,
      missingFiles,
      compiled: false,
      diagnostics: [],
      summary:
        `The pinned baseline is missing ${missingFiles.length} required staged ` +
        `file(s): ${missingFiles.join(", ")}. Compilation was not attempted.`
    };

  const compile = await ports.compileBaseline();
  if (!compile.ok)
    return {
      ok: false,
      missingFiles: [],
      compiled: false,
      diagnostics: compile.diagnostics,
      summary:
        "The pinned baseline carries every required staged file but no longer compiles:\n" +
        formatDiagnostics(compile.diagnostics)
    };

  return {
    ok: true,
    missingFiles: [],
    compiled: true,
    diagnostics: compile.diagnostics,
    summary: ""
  };
}

/** Throws with the full explanation unless the baseline conforms. */
export async function assertBaselineConformance(
  ports: BaselineConformancePorts
): Promise<BaselineConformanceResult> {
  const result = await evaluateBaselineConformance(ports);
  if (!result.ok) throw new Error(result.summary);
  return result;
}

function formatDiagnostics(diagnostics: readonly string[]): string {
  return diagnostics.length === 0 ?
      "  (the compiler reported no diagnostics)"
    : diagnostics.map((diagnostic) => `  ${diagnostic}`).join("\n");
}
