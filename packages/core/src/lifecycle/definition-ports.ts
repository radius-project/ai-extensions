import type { ValidationReport } from "./contracts/common.js";
import type { PortResult, ReadResult } from "./errors.js";
import type {
  AuthorizedScope,
  RequestControl,
  SourceAccessPort,
  SourceCapture,
  SourceSelection,
  SourceSnapshot,
  StagedOutputs
} from "./ports.js";
import type {
  ValidationIdentity,
  ValidationPolicy
} from "./validation-policy.js";

export interface DefinitionValidationRequest extends ValidationIdentity {
  readonly snapshot: SourceSnapshot;
  readonly policy: ValidationPolicy;
}
export interface DefinitionValidationPort {
  validate(
    request: DefinitionValidationRequest,
    control: RequestControl
  ): Promise<PortResult<ValidationReport>>;
}
export interface DefinitionAuthoringSourcePort extends Pick<
  SourceAccessPort,
  | "prepareStaging"
  | "inspectStagedOutputs"
  | "promote"
  | "releaseSnapshot"
  | "releaseStaging"
> {
  /** Captures expected absence only for explicit first-model authoring. */
  captureForAuthoring(
    scope: AuthorizedScope<"definition.author">,
    selection: SourceSelection,
    control: RequestControl
  ): Promise<ReadResult<SourceCapture>>;
  /** Owns exact proposed bytes and their complete effective input closure. */
  captureProposal(
    outputs: StagedOutputs,
    control: RequestControl
  ): Promise<ReadResult<SourceCapture>>;
}
