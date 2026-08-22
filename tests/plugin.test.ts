import type { RequestContext, SendRequest, UniversalResponse } from "@hyperttp/types";
import { describe, expect, it, vi } from "vitest";
import { withInflight } from "../src/index.js";

function context(signal?: AbortSignal): RequestContext {
  return {
    requestId: "request-id",
    startTime: performance.now(),
    signal,
    meta: {},
    state: {},
  };
}

function restRequest(url: string, method = "GET", signal?: AbortSignal): SendRequest {
  return { protocol: "rest", input: { method, url }, signal };
}

const response: UniversalResponse<{ value: number }> = {
  protocol: "rest",
  ok: true,
  status: 200,
  headers: { "content-type": "application/json" },
  data: { value: 1 },
};

describe("withInflight", () => {
  it("deduplicates REST GET requests by URL by default", async () => {
    const plugin = withInflight<unknown, { value: number }>();
    const primary = restRequest("https://example.test/items");
    const duplicate = restRequest("https://example.test/items");

    expect(await plugin.onRequest?.(primary)).toBeUndefined();
    const duplicateResult = plugin.onRequest?.(duplicate);
    expect(duplicateResult).toBeInstanceOf(Promise);

    plugin.onResponse?.(response, primary);
    const clonedResponse = await duplicateResult;

    expect(clonedResponse).toEqual(response);
    expect(clonedResponse).not.toBe(response);
    expect(
      clonedResponse && "headers" in clonedResponse ? clonedResponse.headers : undefined,
    ).not.toBe(response.headers);
  });

  it("keeps REST defaults for method, URL, metadata, and signals", async () => {
    const plugin = withInflight();
    const controller = new AbortController();

    expect(await plugin.onRequest?.(restRequest("/post", "POST"))).toBeUndefined();
    expect(
      await plugin.onRequest?.({ protocol: "rest", input: { method: "GET" } }),
    ).toBeUndefined();
    expect(
      await plugin.onRequest?.({
        ...restRequest("/skipped"),
        metadata: { skipInflight: true },
      }),
    ).toBeUndefined();
    expect(
      await plugin.onRequest?.(restRequest("/signalled", "GET", controller.signal)),
    ).toBeUndefined();
  });

  it("supports protocol-neutral predicates and keys", async () => {
    type RpcInput = { operation: string; id: number };
    const requestCtx = context();
    const shouldDedupe = vi.fn((request: SendRequest<RpcInput>, ctx?: RequestContext) => {
      expect(ctx).toBe(requestCtx);
      return request.input.operation === "lookup";
    });
    const keyExtractor = vi.fn(
      (request: SendRequest<RpcInput>, ctx?: RequestContext): PropertyKey => {
        expect(ctx).toBe(requestCtx);
        return request.input.id;
      },
    );
    const plugin = withInflight<RpcInput>({ shouldDedupe, keyExtractor });
    const primary: SendRequest<RpcInput> = {
      protocol: "rpc",
      input: { operation: "lookup", id: 7 },
    };
    const duplicate: SendRequest<RpcInput> = {
      protocol: "rpc",
      input: { operation: "lookup", id: 7 },
    };

    expect(await plugin.onRequest?.(primary, undefined, requestCtx)).toBeUndefined();
    const duplicateResult = plugin.onRequest?.(duplicate, undefined, requestCtx);
    plugin.onResponse?.({ ...response, protocol: "rpc" }, primary);

    await expect(duplicateResult).resolves.toMatchObject({ protocol: "rpc" });
    expect(shouldDedupe).toHaveBeenCalledTimes(2);
    expect(keyExtractor).toHaveBeenCalledTimes(2);
  });

  it("allows a duplicate with an AbortSignal to cancel independently when enabled", async () => {
    const primaryController = new AbortController();
    const duplicateController = new AbortController();
    const plugin = withInflight<unknown, { value: number }>({ allowAbortSignal: true });
    const primary = restRequest("/abort", "GET", primaryController.signal);
    const duplicate = restRequest("/abort", "GET", duplicateController.signal);

    await plugin.onRequest?.(primary);
    const duplicateResult = plugin.onRequest?.(duplicate);
    duplicateController.abort();

    await expect(duplicateResult).rejects.toMatchObject({ name: "AbortError" });
    plugin.onResponse?.(response, primary);
  });

  it("clears a failed flight so a subsequent request can become primary", async () => {
    const plugin = withInflight();
    const primary = restRequest("/failure");
    const duplicate = restRequest("/failure");

    await plugin.onRequest?.(primary);
    const duplicateResult = plugin.onRequest?.(duplicate);
    const error = new Error("network failed");
    plugin.onError?.(error, primary);

    await expect(duplicateResult).rejects.toBe(error);
    expect(await plugin.onRequest?.(restRequest("/failure"))).toBeUndefined();
  });
});
