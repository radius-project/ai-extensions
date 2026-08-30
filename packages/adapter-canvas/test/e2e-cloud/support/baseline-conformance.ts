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
