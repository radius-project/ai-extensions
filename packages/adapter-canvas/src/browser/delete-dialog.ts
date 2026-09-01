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

export type DeploymentDialogVariant = "delete" | "abandon";

export interface DeleteDialogOptions {
  modalId?: string;
  bodyId?: string;
  appId?: string;
  envId?: string;
  closeId?: string;
  variant?: DeploymentDialogVariant;
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

const FOCUSABLE_SELECTOR =
  "a[href], button, input, select, textarea, [tabindex]";

export const DELETE_DIALOG_FOCUSABLE_SELECTOR = FOCUSABLE_SELECTOR;

export function deleteDialogConfirmToken(
  app: string,
  environment: string,
  _variant: DeploymentDialogVariant = "delete"
): string {
  return `${app}/${environment}`;
}

export function deleteDialogIntentSpecs(
  variant: DeploymentDialogVariant = "delete"
): readonly ElementSpec[] {
  if (variant === "abandon") {
    return [
      {
        tag: "p",
        className: "rad-ddlg__text",
        text: "Stopping tracking removes this failed teardown from Radius Canvas and GitHub. It does not delete cloud resources."
      },
      {
        tag: "button",
        id: DELETE_DIALOG_STEP1_BUTTON_ID,
        className: "rad-ddlg__btn",
        attrs: { type: "button" },
        text: "I want to stop tracking this deployment"
      }
    ];
  }
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
  target: DeleteTarget,
  variant: DeploymentDialogVariant = "delete"
): readonly ElementSpec[] {
  if (variant === "abandon") {
    return [
      {
        tag: "div",
        className: "rad-ddlg__warn",
        children: [
          { tag: "span", attrs: { "aria-hidden": "true" }, text: "⚠" },
          {
            tag: "span",
            text: "Cloud resources will not be deleted. Resources created before the deployment failed may remain and must be cleaned up separately."
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
              { tag: "span", text: "This will stop tracking " },
              { tag: "strong", text: target.app },
              { tag: "span", text: " in environment " },
              { tag: "strong", text: target.environment },
              {
                tag: "span",
                text: " without changing any cloud resources."
              }
            ]
          }
        ]
      },
      {
        tag: "button",
        id: DELETE_DIALOG_STEP2_BUTTON_ID,
        className: "rad-ddlg__btn",
        attrs: { type: "button" },
        text: "I understand cloud resources may remain"
      }
    ];
  }
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
  target: DeleteTarget,
  variant: DeploymentDialogVariant = "delete"
): readonly ElementSpec[] {
  const token = deleteDialogConfirmToken(
    target.app,
    target.environment,
    variant
  );
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
      text:
        variant === "abandon" ?
          "Stop tracking deployment"
        : "Delete this deployment"
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
  const variant = options.variant ?? "delete";

  const owned: Registration[] = [];
  const stepBindings: Registration[] = [];
  let returnFocusTo: DomElement | null = null;

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

  // A destructive dialog must own focus while it is open and hand it back to
  // the control that opened it, otherwise keyboard and screen-reader users are
  // left on the page behind the modal with no way back to their place.
  const focusableIn = (root: DomElement): readonly DomElement[] =>
    dom.all(root, FOCUSABLE_SELECTOR).filter((element) => {
      const disabled = Reflect.get(element, "disabled");
      return disabled !== true;
    });

  const focusableInModal = (): readonly DomElement[] => focusableIn(modal);

  // Prefer the current step's own controls so the dialog opens on its primary
  // action rather than on the decorative close affordance.
  const focusFirstControl = (): void => {
    const [first] = [...focusableIn(body), ...focusableInModal()];
    if (first) context.focus.focus(first);
  };

  const close = (): void => {
    modal.style.display = "none";
    releaseStepBindings();
    body.replaceChildren();
    const invoker = returnFocusTo;
    returnFocusTo = null;
    if (invoker) context.focus.focus(invoker);
  };

  const confirmNow = (target: DeleteTarget): void => {
    close();
    options.onConfirm?.(target.app, target.environment);
  };

  const showIntent = (target: DeleteTarget): void => {
    const nodes = renderStep(deleteDialogIntentSpecs(variant));
    bind(stepBindings, nodes[1], "click", () => {
      showEffects(target);
    });
    focusFirstControl();
  };

  const showEffects = (target: DeleteTarget): void => {
    const nodes = renderStep(deleteDialogEffectsSpecs(target, variant));
    bind(stepBindings, nodes[2], "click", () => {
      showConfirm(target);
    });
    focusFirstControl();
  };

  const showConfirm = (target: DeleteTarget): void => {
    const nodes = renderStep(deleteDialogConfirmSpecs(target, variant));
    const token = deleteDialogConfirmToken(
      target.app,
      target.environment,
      variant
    );
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
    returnFocusTo = context.focus.active();
    if (appEl) appEl.textContent = app;
    if (envEl) envEl.textContent = environment;
    // The modal has to be visible before the first step renders: a control
    // inside a hidden subtree cannot take focus.
    modal.style.display = "flex";
    showIntent({ app, environment });
  };

  if (closeEl) bind(owned, closeEl, "click", close);
  bind(owned, modal, "click", (event) => {
    if (event.target === modal) close();
  });
  bind(owned, dom.document, "keydown", (event) => {
    if (modal.style.display !== "flex") return;
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key !== "Tab") return;
    // Keep Tab inside the modal so the confirmation cannot be skipped by
    // tabbing back onto the page underneath it.
    const focusable = focusableInModal();
    if (focusable.length === 0) return;
    const active = context.focus.active();
    const index = focusable.findIndex((element) => element === active);
    const shift = Reflect.get(event, "shiftKey") === true;
    if (index === -1) {
      event.preventDefault();
      context.focus.focus(focusable[shift ? focusable.length - 1 : 0]);
      return;
    }
    const atEdge = shift ? index === 0 : index === focusable.length - 1;
    if (!atEdge) return;
    event.preventDefault();
    context.focus.focus(focusable[shift ? focusable.length - 1 : 0]);
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
