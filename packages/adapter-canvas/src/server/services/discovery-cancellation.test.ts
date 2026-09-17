import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  discoveryCancellation,
  discoveryControl
} from "./discovery-cancellation.js";

it("binds discovery cancellation to response lifetime and disposes its listener", () => {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  const response = new ServerResponse(request);
  try {
    const cancellation = discoveryCancellation(
      createRequestContext(request, response, "panel", new Map())
    );
    let aborted = 0;
    const dispose = cancellation.onAbort(() => {
      aborted++;
    });
    expect(cancellation.aborted).toBe(false);
    response.emit("close");
    expect(aborted).toBe(1);
    dispose();
    expect(response.listenerCount("close")).toBe(0);
    response.destroy();
    expect(cancellation.aborted).toBe(true);
    const disposeLate = cancellation.onAbort(() => {
      aborted++;
    });
    expect(aborted).toBe(2);
    expect(response.listenerCount("close")).toBe(0);
    disposeLate();
    disposeLate();
  } finally {
    response.destroy();
    request.destroy();
    socket.destroy();
  }
});

it.each([false, true])(
  "adapts an already-aborted=%s read session and disposes subscriptions",
  (alreadyAborted) => {
    const abort = new AbortController();
    if (alreadyAborted) abort.abort();
    const control = discoveryControl("request-one", abort.signal);
    expect(control.requestId).toBe("request-one");
    expect(control.cancellation.aborted).toBe(alreadyAborted);
    let notifications = 0;
    const dispose = control.cancellation.onAbort(() => {
      notifications++;
    });
    expect(notifications).toBe(alreadyAborted ? 1 : 0);
    abort.abort();
    expect(control.cancellation.aborted).toBe(true);
    expect(notifications).toBe(1);
    dispose();
    dispose();
  }
);

it("unsubscribes a read-session observer before cancellation", () => {
  const abort = new AbortController();
  const control = discoveryControl("request-two", abort.signal);
  let notifications = 0;
  const dispose = control.cancellation.onAbort(() => {
    notifications++;
  });
  dispose();
  dispose();
  abort.abort();
  expect(notifications).toBe(0);
});
