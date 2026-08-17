import { describe, expect, it } from "vitest";
import {
  CLIENT_DELETE_DIALOG_JS,
  CLIENT_OPCHIP_JS
} from "./client.js";

describe("client compatibility facade", () => {
  it("keeps every deferred 4C script parseable", () => {
    for (const source of [CLIENT_OPCHIP_JS, CLIENT_DELETE_DIALOG_JS]) {
      expect(() => new Function(source)).not.toThrow();
    }
  });
});

interface LegacyElement {
  hidden: boolean;
  className: string;
  textContent: string;
  innerHTML: string;
  value: string;
  disabled: boolean;
  style: { display: string };
  dataset: Record<string, string>;
  offsetParent: object | null;
  attributes: Record<string, string>;
  listeners: Record<string, Array<(event: Record<string, unknown>) => void>>;
  setAttribute(name: string, value: string): void;
  addEventListener(
    type: string,
    listener: (event: Record<string, unknown>) => void
  ): void;
  focus(): void;
  dispatch(type: string, event?: Record<string, unknown>): void;
}

function element(): LegacyElement {
  const value: LegacyElement = {
    hidden: true,
    className: "",
    textContent: "",
    innerHTML: "",
    value: "",
    disabled: false,
    style: { display: "none" },
    dataset: {},
    offsetParent: {},
    attributes: {},
    listeners: {},
    setAttribute(name, attributeValue) {
      value.attributes[name] = attributeValue;
    },
    addEventListener(type, listener) {
      value.listeners[type] = [...(value.listeners[type] ?? []), listener];
    },
    focus() {},
    dispatch(type, event = {}) {
      for (const listener of value.listeners[type] ?? []) listener(event);
    }
  };
  return value;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("remaining operation-chip legacy behavior", () => {
  it("renders a running operation and acknowledges a terminal one", async () => {
    const chip = element();
    const label = element();
    const storage = new Map<string, string>();
    let operation: Record<string, unknown> = {
      operationId: "op-1",
      environment: "dev",
      state: "running"
    };
    const document = {
      visibilityState: "visible",
      getElementById(id: string) {
        if (id === "rad-opchip") return chip;
        if (id === "rad-opchip-label") return label;
        return null;
      },
      addEventListener() {}
    };
    const window = {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value)
      }
    };
    let poll: (() => void) | null = null;
    const fetch = () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ operation })
      });
    new Function(
      "window",
      "document",
      "fetch",
      "setInterval",
      CLIENT_OPCHIP_JS
    )(window, document, fetch, (handler: () => void) => {
      poll = handler;
      return 1;
    });
    await flush();

    expect(chip.hidden).toBe(false);
    expect(label.textContent).toBe("Setting up dev…");

    chip.dispatch("click");
    operation = {
      operationId: "op-1",
      environment: "dev",
      state: "succeeded"
    };
    if (poll) (poll as () => void)();
    await flush();
    expect(chip.hidden).toBe(true);
  });
});

describe("remaining delete-dialog legacy behavior", () => {
  it("returns no dialog when its required markup is absent", () => {
    const factory = new Function(
      "document",
      `${CLIENT_DELETE_DIALOG_JS}; return radiusCreateDeleteDeploymentDialog;`
    )({ getElementById: () => null });
    expect(factory({})).toBeNull();
  });

  it("opens the first confirmation step and escapes the selected target", () => {
    const modal = element();
    const body = element();
    const app = element();
    const environment = element();
    const close = element();
    const stepOne = element();
    const stepTwo = element();
    const elements: Record<string, LegacyElement> = {
      "deploy-delete-modal": modal,
      "deploy-delete-body": body,
      "deploy-delete-app": app,
      "deploy-delete-env": environment,
      "deploy-delete-close": close,
      "del-step1-btn": stepOne,
      "del-step2-btn": stepTwo
    };
    const document = {
      getElementById: (id: string) => elements[id] ?? null,
      addEventListener() {}
    };
    const factory = new Function(
      "document",
      `${CLIENT_DELETE_DIALOG_JS}; return radiusCreateDeleteDeploymentDialog;`
    )(document);
    const dialog = factory({});

    dialog.open("<app>", "dev&west");
    expect(modal.style.display).toBe("flex");
    expect(app.textContent).toBe("<app>");
    expect(environment.textContent).toBe("dev&west");

    stepOne.dispatch("click");
    expect(body.innerHTML).toContain("&lt;app&gt;");
    expect(body.innerHTML).toContain("dev&amp;west");
  });
});
