// Canvas adapter — the three-step confirmation the deployment pages use before
// tearing down a deployment.
//
// The dialog is deliberately hostile to accidents. Each step is built from
// element specs, so an application or environment name can never re-enter the
// page as markup, and the controls are kept by reference rather than looked up
// again by id, so a step can never render with an unbound button. The final
// step stays disabled until the typed token matches exactly.

import { buildElement } from "./dom.js";
import type { ElementSpec } from "./dom.js";
import type {
  BrowserContext,
  DomElement,
  DomEventListener,
  DomEventTarget,
  DomInputElement
} from "./ports.js";

export const DELETE_DIALOG_IDS = {
  modal: "deploy-delete-modal",
  body: "deploy-delete-body",
  app: "deploy-delete-app",
  environment: "deploy-delete-env",
  close: "deploy-delete-close"
} as const;

export const DELETE_DIALOG_STEP1_BUTTON_ID = "del-step1-btn";
export const DELETE_DIALOG_STEP2_BUTTON_ID = "del-step2-btn";
export const DELETE_DIALOG_CONFIRM_INPUT_ID = "del-confirm-input";
export const DELETE_DIALOG_CONFIRM_BUTTON_ID = "del-confirm-btn";

export interface DeleteDialogOptions {
  modalId?: string;
  bodyId?: string;
  appId?: string;
  envId?: string;
  closeId?: string;
  onConfirm?: (app: string, environment: string) => void;
}

export interface DeleteDialogHandle {
  open(app: string, environment: string): void;
  close(): void;
  teardown(): void;
}

export interface DeleteTarget {
  readonly app: string;
  readonly environment: string;
}

interface Registration {
  readonly target: DomEventTarget;
  readonly type: string;
  readonly listener: DomEventListener;
}

export function deleteDialogConfirmToken(
  app: string,
  environment: string
): string {
  return `${app}/${environment}`;
}

export function deleteDialogIntentSpecs(): readonly ElementSpec[] {
  return [
    {
      tag: "p",
      className: "rad-ddlg__text",
      text: "Deleting this deployment will tear down running containers and resources. To proceed, please confirm your intention."
    },
    {
      tag: "button",
      id: DELETE_DIALOG_STEP1_BUTTON_ID,
      className: "rad-ddlg__btn",
      attrs: { type: "button" },
      text: "I want to delete this deployment"
    }
  ];
}

export function deleteDialogEffectsSpecs(
  target: DeleteTarget
): readonly ElementSpec[] {
  return [
    {
      tag: "div",
      className: "rad-ddlg__warn",
      children: [
        { tag: "span", attrs: { "aria-hidden": "true" }, text: "⚠" },
        {
          tag: "span",
          text: "This action cannot be undone. Please read carefully!"
        }
      ]
    },
    {
      tag: "div",
      className: "rad-ddlg__bullet",
      children: [
        {
          tag: "span",
          children: [
            {
              tag: "span",
              text: "This will permanently delete the deployment of "
            },
            { tag: "strong", text: target.app },
            { tag: "span", text: " from environment " },
            { tag: "strong", text: target.environment },
            { tag: "span", text: ", including all associated resources." }
          ]
        }
      ]
    },
    {
      tag: "button",
      id: DELETE_DIALOG_STEP2_BUTTON_ID,
      className: "rad-ddlg__btn",
      attrs: { type: "button" },
      text: "I have read and understand these effects"
    }
  ];
}

export function deleteDialogConfirmSpecs(
  target: DeleteTarget
): readonly ElementSpec[] {
  const token = deleteDialogConfirmToken(target.app, target.environment);
  return [
    {
      tag: "p",
      className: "rad-ddlg__confirm-label",
      text: `To confirm, type "${token}" in the box below`
    },
    {
      tag: "input",
      id: DELETE_DIALOG_CONFIRM_INPUT_ID,
      className: "rad-ddlg__input",
      attrs: {
        type: "text",
        autocomplete: "off",
        autocapitalize: "off",
        spellcheck: "false",
        placeholder: token
      }
    },
    {
      tag: "button",
      id: DELETE_DIALOG_CONFIRM_BUTTON_ID,
      className: "rad-ddlg__delete",
      attrs: { type: "button" },
      text: "Delete this deployment"
    }
  ];
}

function asInput(element: DomElement): DomInputElement {
  const value = Reflect.get(element, "value");
  const disabled = Reflect.get(element, "disabled");
  if (typeof value !== "string" || typeof disabled !== "boolean") {
    throw new Error(
      `Radius delete dialog could not create the "${element.id}" control.`
    );
  }
  return element as DomInputElement;
}

export function createDeleteDeploymentDialog(
  context: BrowserContext,
  options: DeleteDialogOptions = {}
): DeleteDialogHandle | null {
  const dom = context.dom;
  const modal = dom.byId(options.modalId ?? DELETE_DIALOG_IDS.modal);
  const body = dom.byId(options.bodyId ?? DELETE_DIALOG_IDS.body);
  if (!modal || !body) return null;
  const appEl = dom.byId(options.appId ?? DELETE_DIALOG_IDS.app);
  const envEl = dom.byId(options.envId ?? DELETE_DIALOG_IDS.environment);
  const closeEl = dom.byId(options.closeId ?? DELETE_DIALOG_IDS.close);

  const owned: Registration[] = [];
  const stepBindings: Registration[] = [];

  const bind = (
    into: Registration[],
    target: DomEventTarget,
    type: string,
    listener: DomEventListener
  ): void => {
    target.addEventListener(type, listener);
    into.push({ target, type, listener });
  };

  const releaseStepBindings = (): void => {
    for (const entry of stepBindings.splice(0)) {
      entry.target.removeEventListener(entry.type, entry.listener);
    }
  };

  const renderStep = (specs: readonly ElementSpec[]): DomElement[] => {
    releaseStepBindings();
    const nodes = specs.map((spec) => buildElement(dom, spec));
    body.replaceChildren(...nodes);
    return nodes;
  };

  const close = (): void => {
    modal.style.display = "none";
    releaseStepBindings();
    body.replaceChildren();
  };

  const confirmNow = (target: DeleteTarget): void => {
    close();
    options.onConfirm?.(target.app, target.environment);
  };

  const showIntent = (target: DeleteTarget): void => {
    const nodes = renderStep(deleteDialogIntentSpecs());
    bind(stepBindings, nodes[1], "click", () => {
      showEffects(target);
    });
  };

  const showEffects = (target: DeleteTarget): void => {
    const nodes = renderStep(deleteDialogEffectsSpecs(target));
    bind(stepBindings, nodes[2], "click", () => {
      showConfirm(target);
    });
  };

  const showConfirm = (target: DeleteTarget): void => {
    const nodes = renderStep(deleteDialogConfirmSpecs(target));
    const token = deleteDialogConfirmToken(target.app, target.environment);
    const input = asInput(nodes[1]);
    const confirm = asInput(nodes[2]);
    confirm.disabled = true;
    const matches = (): boolean => input.value.trim() === token;
    bind(stepBindings, input, "input", () => {
      confirm.disabled = !matches();
    });
    bind(stepBindings, input, "keydown", (event) => {
      if (event.key === "Enter" && matches()) confirmNow(target);
    });
    bind(stepBindings, confirm, "click", () => {
      if (matches()) confirmNow(target);
    });
    input.focus();
  };

  const open = (app: string, environment: string): void => {
    if (appEl) appEl.textContent = app;
    if (envEl) envEl.textContent = environment;
    showIntent({ app, environment });
    modal.style.display = "flex";
  };

  if (closeEl) bind(owned, closeEl, "click", close);
  bind(owned, modal, "click", (event) => {
    if (event.target === modal) close();
  });
  bind(owned, dom.document, "keydown", (event) => {
    if (event.key === "Escape" && modal.style.display === "flex") close();
  });

  return {
    open,
    close,
    teardown() {
      releaseStepBindings();
      for (const entry of owned.splice(0)) {
        entry.target.removeEventListener(entry.type, entry.listener);
      }
    }
  };
}
