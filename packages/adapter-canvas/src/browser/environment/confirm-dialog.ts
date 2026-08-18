import type {
  BrowserContext,
  DomElement,
  DomEventListener,
  DomEventTarget
} from "../ports.js";

export interface EnvironmentConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly usageLabel?: string;
  readonly usage?: readonly string[];
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly confirmVariant?: "danger" | "primary";
  readonly onConfirm: () => void;
}

export interface EnvironmentConfirmDialog {
  show(options: EnvironmentConfirmOptions): void;
  close(): void;
  teardown(): void;
}

interface Registration {
  readonly target: DomEventTarget;
  readonly type: string;
  readonly listener: DomEventListener;
}

export function createEnvironmentConfirmDialog(
  context: BrowserContext
): EnvironmentConfirmDialog | null {
  const modal = context.dom.byId("env-confirm-modal");
  const title = context.dom.byId("env-confirm-title");
  const message = context.dom.byId("env-confirm-message");
  const usageBlock = context.dom.byId("env-confirm-usage");
  const usageLabel = context.dom.byId("env-confirm-usage-label");
  const usageList = context.dom.byId("env-confirm-usage-list");
  const cancel = context.dom.byId("env-confirm-cancel");
  const confirm = context.dom.byId("env-confirm-ok");
  if (
    !modal ||
    !title ||
    !message ||
    !usageBlock ||
    !usageLabel ||
    !usageList ||
    !cancel ||
    !confirm
  ) {
    return null;
  }

  const registrations: Registration[] = [];
  let pendingConfirm: (() => void) | null = null;
  let restoreFocusTo: DomElement | null = null;
  const bind = (
    target: DomEventTarget,
    type: string,
    listener: DomEventListener
  ): void => {
    target.addEventListener(type, listener);
    registrations.push({ target, type, listener });
  };
  const isOpen = (): boolean => modal.style.display !== "none";
  const close = (): void => {
    modal.style.display = "none";
    pendingConfirm = null;
    // Return focus to whatever opened the dialog, so keyboard users are not
    // dropped at the top of the document once it closes.
    const restore = restoreFocusTo;
    restoreFocusTo = null;
    context.focus.focus(restore);
  };
  bind(cancel, "click", close);
  bind(confirm, "click", () => {
    const run = pendingConfirm;
    close();
    run?.();
  });
  bind(context.dom.document, "keydown", (event) => {
    if (!isOpen()) return;
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key !== "Tab") return;
    // The dialog is aria-modal, so Tab must cycle between its two buttons
    // instead of walking into the inert page behind it.
    event.preventDefault();
    const active = context.focus.active();
    const backwards = event.shiftKey === true;
    const next =
      backwards ?
        active === confirm ?
          cancel
        : confirm
      : active === cancel ? confirm
      : cancel;
    next.focus();
  });

  return {
    show(options) {
      if (!isOpen()) restoreFocusTo = context.focus.active();
      pendingConfirm = options.onConfirm;
      title.textContent = options.title;
      message.textContent = options.message;
      confirm.textContent = options.confirmLabel;
      confirm.className =
        options.confirmVariant === "primary" ?
          "rad-btn rad-btn--primary"
        : "rad-btn rad-btn--danger-outline";
      cancel.textContent = options.cancelLabel ?? "Cancel";
      usageList.replaceChildren(
        ...(options.usage ?? []).map((item) => {
          const element: DomElement = context.dom.createElement("li");
          element.textContent = item;
          return element;
        })
      );
      usageLabel.textContent = options.usageLabel ?? "";
      usageBlock.style.display = (options.usage?.length ?? 0) > 0 ? "" : "none";
      modal.style.display = "flex";
      cancel.focus();
    },
    close,
    teardown() {
      // Teardown is not a user-driven dismissal, so it must not yank focus
      // back to whatever opened the dialog.
      restoreFocusTo = null;
      close();
      for (const registration of registrations.splice(0)) {
        registration.target.removeEventListener(
          registration.type,
          registration.listener
        );
      }
    }
  };
}
