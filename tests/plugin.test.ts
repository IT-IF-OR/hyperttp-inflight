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
  it.each([false, true])(
    "bypasses authenticated requests without identity (custom key: %s)",
    async (custom) => {
      const keyExtractor = vi.fn(() => "safe-path");
      const plugin = withInflight(custom ? { keyExtractor } : {});
      const ctx = context();
      ctx.state["@hyperttp/auth.applied"] = true;
      for (let i = 0; i < 2; i++) {
        expect(await plugin.onRequest?.(restRequest("/me"), undefined, ctx)).toBeUndefined();
      }
      expect(keyExtractor).not.toHaveBeenCalled();
    },
  );

  it("bypasses default URL keys when authenticated identity is present", async () => {
    const plugin = withInflight();
    const ctx = context();
    ctx.state["@hyperttp/auth.identity"] = "user:one";
    ctx.state["@hyperttp/auth.applied"] = true;
    for (let i = 0; i < 2; i++) {
      expect(
        await plugin.onRequest?.(restRequest("/me?key=synthetic-secret"), undefined, ctx),
      ).toBeUndefined();
    }
  });

  it("bypasses manually supplied authorization headers without identity", async () => {
    const plugin = withInflight();
    for (let i = 0; i < 2; i++) {
      expect(
        await plugin.onRequest?.({
          ...restRequest("/me"),
          input: {
            method: "GET",
            url: "/me",
            headers: { authorization: "Bearer synthetic-secret" },
          },
        }),
      ).toBeUndefined();
    }
  });

  it("handles a failed primary without followers and releases its key", async () => {
    const plugin = withInflight();
    const primary = restRequest("/timeout");
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    await plugin.onRequest?.(primary);
    plugin.onError?.(timeout, primary);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await plugin.onRequest?.(restRequest("/timeout"))).toBeUndefined();
  });

  it("preserves the original rejection for all followers", async () => {
    const plugin = withInflight();
    const primary = restRequest("/failure");
    await plugin.onRequest?.(primary);
    const followers = [
      plugin.onRequest?.(restRequest("/failure")),
      plugin.onRequest?.(restRequest("/failure")),
    ];
    const settled = Promise.allSettled(followers);
    const error = new Error("request failed");
    plugin.onError?.(error, primary);
    expect(await settled).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error },
    ]);
  });

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

  it("does not deduplicate requests belonging to different auth identities", async () => {
    const plugin = withInflight();
    const firstContext = context();
    const secondContext = context();
    firstContext.state["@hyperttp/auth.identity"] = "user:one";
    secondContext.state["@hyperttp/auth.identity"] = "user:two";

    expect(
      await plugin.onRequest?.(restRequest("https://example.test/me"), undefined, firstContext),
    ).toBeUndefined();
    expect(
      await plugin.onRequest?.(restRequest("https://example.test/me"), undefined, secondContext),
    ).toBeUndefined();
  });

  it.each([() => "shared-key"])(
    "partitions explicit safe keys by auth identity (%s)",
    async (keyExtractor) => {
      const plugin = withInflight({ keyExtractor });
      const primary = restRequest("/me");
      const authenticated = context();
      authenticated.state["@hyperttp/auth.identity"] = "user:one";
      await plugin.onRequest?.(primary, undefined, authenticated);

      expect(await plugin.onRequest?.(restRequest("/me"), undefined, context())).toBeUndefined();
      const sameIdentity = context();
      sameIdentity.state["@hyperttp/auth.identity"] = "user:one";
      const duplicate = plugin.onRequest?.(restRequest("/me"), undefined, sameIdentity);
      plugin.onResponse?.(response, primary);
      await expect(duplicate).resolves.toEqual(response);
      expect(await plugin.onRequest?.(restRequest("/me"), undefined, sameIdentity)).toBeUndefined();
    },
  );

  it("does not serialize credentials or identity when partitioning custom keys", async () => {
    const plugin = withInflight({ keyExtractor: () => "safe-resource-key" });
    const requestCtx = context();
    requestCtx.state["@hyperttp/auth.identity"] = {
      toJSON() {
        throw new Error("Identity must not be serialized");
      },
    };
    const primary = restRequest("/me?api_key=secret");
    await expect(plugin.onRequest?.(primary, undefined, requestCtx)).resolves.toBeUndefined();
    const duplicate = plugin.onRequest?.(restRequest("/me?api_key=rotated"), undefined, requestCtx);
    plugin.onResponse?.(response, primary);
    await expect(duplicate).resolves.toEqual(response);
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

type Outcome = { ok: true; response: UniversalResponse } | { ok: false; error: unknown };

function lifecycleContext() {
  const callbacks: Array<(outcome: Outcome) => void> = [];
  const ctx = {
    ...context(),
    onSettled: vi.fn((callback: (outcome: Outcome) => void) => callbacks.push(callback)),
    acceptFinalResponse: vi.fn(<T>(result: UniversalResponse<T>) => result),
  };
  return { ctx, settle: (outcome: Outcome) => callbacks.forEach((callback) => callback(outcome)) };
}

describe("inflight settlement lifecycle", () => {
  it("shares only the final response and marks followers to skip repeated transformations", async () => {
    const plugin = withInflight();
    const primary = lifecycleContext();
    const follower = lifecycleContext();
    await plugin.onRequest?.(restRequest("/final"), undefined, primary.ctx);
    let completed = false;
    const waiting = Promise.resolve(
      plugin.onRequest?.(restRequest("/final"), undefined, follower.ctx),
    ).then((result) => {
      completed = true;
      return result;
    });
    expect(primary.ctx.onSettled).toHaveBeenCalledTimes(1);
    expect(follower.ctx.onSettled).not.toHaveBeenCalled();
    // Core may replace the request object while retaining its lifecycle context.
    plugin.onResponse?.(response, restRequest("/final"), undefined, primary.ctx);
    plugin.onError?.(new Error("intermediate"), restRequest("/final"), undefined, primary.ctx);
    await Promise.resolve();
    expect(completed).toBe(false);
    const final = { ...response, data: { value: 42 } };
    primary.settle({ ok: true, response: final });
    const result = await waiting;
    expect(result).toEqual(final);
    expect(result).not.toBe(final);
    expect(follower.ctx.acceptFinalResponse).toHaveBeenCalledExactlyOnceWith(result);
    expect(
      await plugin.onRequest?.(restRequest("/final"), undefined, lifecycleContext().ctx),
    ).toBeUndefined();
    primary.settle({ ok: false, error: new Error("duplicate settlement") });
  });

  it.each(["transport", "transform", "abort"])(
    "shares final %s failures and frees the key",
    async (kind) => {
      const plugin = withInflight();
      const primary = lifecycleContext();
      await plugin.onRequest?.(restRequest("/failure"), undefined, primary.ctx);
      const follower = lifecycleContext();
      const waiting = plugin.onRequest?.(restRequest("/failure"), undefined, follower.ctx);
      const error = kind === "abort" ? new DOMException("aborted", "AbortError") : new Error(kind);
      const rejected = expect(waiting).rejects.toBe(error);
      plugin.onResponse?.(response, restRequest("/failure"), undefined, primary.ctx);
      primary.settle({ ok: false, error });
      await rejected;
      expect(follower.ctx.acceptFinalResponse).not.toHaveBeenCalled();
      expect(
        await plugin.onRequest?.(restRequest("/failure"), undefined, lifecycleContext().ctx),
      ).toBeUndefined();
    },
  );

  it("uses a stable context for legacy hooks after request replacement", async () => {
    const plugin = withInflight();
    const ctx = context();
    await plugin.onRequest?.(restRequest("/replace"), undefined, ctx);
    const waiting = plugin.onRequest?.(restRequest("/replace"));
    plugin.onResponse?.(response, restRequest("/replace"), undefined, ctx);
    await expect(waiting).resolves.toEqual(response);
  });

  it("allows followers without acceptFinalResponse and observes unshared final failures", async () => {
    const plugin = withInflight();
    const primary = lifecycleContext();
    await plugin.onRequest?.(restRequest("/mixed"), undefined, primary.ctx);
    const waiting = plugin.onRequest?.(restRequest("/mixed"), undefined, context());
    primary.settle({ ok: true, response });
    await expect(waiting).resolves.toEqual(response);
    const failed = lifecycleContext();
    await plugin.onRequest?.(restRequest("/mixed"), undefined, failed.ctx);
    failed.settle({ ok: false, error: new Error("no followers") });
    await Promise.resolve();
    expect(await plugin.onRequest?.(restRequest("/mixed"))).toBeUndefined();
  });
});
