import { createDeleteDeploymentDialog } from "../delete-dialog.js";
import { publishBrowserGlobals } from "../globals.js";
import { isCallable, isRecord, readString } from "../json.js";
import { resolvePageContext } from "../registry.js";
import type {
  DeleteDialogOptions,
  DeploymentDialogVariant
} from "../delete-dialog.js";

export const DELETE_DIALOG_FACTORY_GLOBAL =
  "radiusCreateDeleteDeploymentDialog";

function readVariant(value: unknown): DeploymentDialogVariant {
  const variant = readString(value, "variant");
  if (variant === "abandon") return "abandon";
  if (variant === "force") return "force";
  return "delete";
}

function readOptions(value: unknown): DeleteDialogOptions {
  if (!isRecord(value)) return {};
  const onConfirm = value.onConfirm;
  return {
    modalId: readString(value, "modalId") || undefined,
    bodyId: readString(value, "bodyId") || undefined,
    appId: readString(value, "appId") || undefined,
    envId: readString(value, "envId") || undefined,
    closeId: readString(value, "closeId") || undefined,
    variant: readVariant(value),
    onConfirm:
      isCallable(onConfirm) ?
        (app, environment, variant) => {
          onConfirm(app, environment, variant);
        }
      : undefined
  };
}

export function installDeleteDialogEntry(scope: unknown): void {
  const context = resolvePageContext(scope);
  publishBrowserGlobals(
    scope,
    {
      [DELETE_DIALOG_FACTORY_GLOBAL]: (options: unknown) =>
        createDeleteDeploymentDialog(context, readOptions(options))
    },
    [DELETE_DIALOG_FACTORY_GLOBAL]
  );
}
