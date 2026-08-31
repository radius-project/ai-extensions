import type {
  BrowserContext,
  DomElement,
  DomEventListener,
  DomEventTarget
} from "../ports.js";

export interface EnvironmentConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly messageLink?: {
    readonly label: string;
    readonly href: string;
    readonly suffix?: string;
  };
  readonly usageLabel?: string;
  readonly usage?: readonly string[];
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly confirmVariant?: "danger" | "primary";
  // Optional: a pure acknowledgement dialog (e.g. an informational "Environment
  // deleted" notice) confirms with no side effect and simply closes.
  readonly onConfirm?: () => void;
  readonly onCancel?: () => void;
  // Hide the secondary/cancel button so the dialog reads as a single-action
  // acknowledgement (e.g. an informational "Environment deleted" notice) rather
  // than a destructive confirm.
  readonly hideCancel?: boolean;
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
  let pendingCancel: (() => void) | null = null;
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
    pendingCancel = null;
    // Return focus to whatever opened the dialog, so keyboard users are not
    // dropped at the top of the document once it closes.
    const restore = restoreFocusTo;
    restoreFocusTo = null;
    context.focus.focus(restore);
  };
  const cancelPending = (): void => {
    const run = pendingCancel;
    close();
    run?.();
  };
  bind(cancel, "click", cancelPending);
  bind(confirm, "click", () => {
    const run = pendingConfirm;
    close();
    run?.();
  });
  bind(context.dom.document, "keydown", (event) => {
    if (!isOpen()) return;
    if (event.key === "Escape") {
      cancelPending();
      return;
    }
    if (event.key !== "Tab") return;
    // The dialog is aria-modal, so Tab must cycle between its two buttons
    // instead of walking into the inert page behind it. When the cancel button
    // is hidden (an acknowledgement dialog) focus simply stays on confirm.
    event.preventDefault();
    if (cancel.style.display === "none") {
      confirm.focus();
      return;
    }
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
      pendingConfirm = options.onConfirm ?? null;
      pendingCancel = options.onCancel ?? null;
      title.textContent = options.title;
      if (options.messageLink) {
        const prefix = context.dom.createElement("span");
        prefix.textContent = options.message;
        const link = context.dom.createElement("a");
        link.textContent = options.messageLink.label;
        link.setAttribute("href", options.messageLink.href);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
        const suffix = context.dom.createElement("span");
        suffix.textContent = options.messageLink.suffix ?? "";
        message.replaceChildren(prefix, link, suffix);
      } else {
        message.textContent = options.message;
      }
      confirm.textContent = options.confirmLabel;
      confirm.className =
        options.confirmVariant === "primary" ?
          "rad-btn rad-btn--primary"
        : "rad-btn rad-btn--danger-outline";
      cancel.textContent = options.cancelLabel ?? "Cancel";
      const hideCancel = options.hideCancel === true;
      cancel.style.display = hideCancel ? "none" : "";
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
      (hideCancel ? confirm : cancel).focus();
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
