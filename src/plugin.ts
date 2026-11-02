import type {
  HyperClientOptions,
  HyperPlugin,
  RequestContext,
  SendRequest,
  UniversalResponse,
} from "@hyperttp/types";

type HttpInput = { method?: string; url?: string };

const AUTH_IDENTITY_STATE_KEY = "@hyperttp/auth.identity";

export type InflightKey = PropertyKey;

export interface InflightOptions<TInput = unknown> {
  enabled?: boolean;
  shouldDedupe?: (request: SendRequest<TInput>, ctx?: RequestContext) => boolean;
  keyExtractor?: (request: SendRequest<TInput>, ctx?: RequestContext) => InflightKey | undefined;
  allowAbortSignal?: boolean;
}

type SettledOutcome = { ok: true; response: UniversalResponse } | { ok: false; error: unknown };

interface LifecycleContext extends RequestContext {
  onSettled?: (callback: (outcome: SettledOutcome) => void) => void;
  acceptFinalResponse?: <T>(response: UniversalResponse<T>) => UniversalResponse<T>;
}

interface InflightEntry<TOutput> {
  promise: Promise<UniversalResponse<TOutput>>;
  resolve: (response: UniversalResponse<TOutput>) => void;
  reject: (error: unknown) => void;
  key: InflightKey;
  identity: unknown;
  usesSettlement: boolean;
}

function httpInput<TInput>(request: SendRequest<TInput>): HttpInput {
  return request.input !== null && typeof request.input === "object"
    ? (request.input as HttpInput)
    : {};
}

function requestMetadata<TInput>(
  request: SendRequest<TInput>,
  ctx?: RequestContext,
): Record<string, unknown> {
  return { ...ctx?.meta, ...request.metadata };
}

function defaultShouldDedupe<TInput>(request: SendRequest<TInput>): boolean {
  return request.protocol === "rest" && httpInput(request).method === "GET";
}

function defaultKeyExtractor<TInput>(request: SendRequest<TInput>): InflightKey | undefined {
  if (request.protocol !== "rest") return;

  const url = httpInput(request).url;
  if (!url) return;

  return url;
}

function abortError(): DOMException {
  return new DOMException("The user aborted a request.", "AbortError");
}

function waitForEntry<TOutput>(
  entry: InflightEntry<TOutput>,
  signal: AbortSignal | undefined,
  clone: (response: UniversalResponse<TOutput>) => UniversalResponse<TOutput>,
): Promise<UniversalResponse<TOutput>> {
  if (!signal) return entry.promise.then(clone);
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (response) => {
        cleanup();
        resolve(clone(response));
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

declare module "@hyperttp/types" {
  interface HyperClientOptions {
    inflight?: InflightOptions;
  }
}

export function withInflight<TInput = unknown, TOutput = unknown>(
  options: InflightOptions<TInput> = {},
): HyperPlugin<TInput, TOutput> {
  const inflight = new Map<unknown, Map<InflightKey, InflightEntry<TOutput>>>();
  const primaryFlights = new WeakMap<object, InflightEntry<TOutput>>();
  // Older callers may omit the context when invoking response/error hooks.
  const legacyKeys = new WeakMap<object, object>();
  const settle = (key: object, entry: InflightEntry<TOutput>, outcome: SettledOutcome): void => {
    if (primaryFlights.get(key) !== entry) return;
    if (outcome.ok) entry.resolve(outcome.response as UniversalResponse<TOutput>);
    else entry.reject(outcome.error);
    primaryFlights.delete(key);
    const flights = inflight.get(entry.identity);
    if (flights?.get(entry.key) === entry) flights.delete(entry.key);
    if (flights?.size === 0) inflight.delete(entry.identity);
  };
  const shouldDedupe: NonNullable<InflightOptions<TInput>["shouldDedupe"]> =
    options.shouldDedupe ?? ((request) => defaultShouldDedupe(request));
  const keyExtractor: NonNullable<InflightOptions<TInput>["keyExtractor"]> =
    options.keyExtractor ?? ((request) => defaultKeyExtractor(request));

  const safeClone = (response: UniversalResponse<TOutput>): UniversalResponse<TOutput> => ({
    ...response,
    headers: { ...response.headers },
  });

  return {
    name: "hyperttp-inflight",
    phase: "PREPARE",
    enabled: (config: HyperClientOptions): boolean => {
      if (options.enabled === false) return false;
      return config.inflight?.enabled !== false;
    },
    async onRequest(request, _pluginCtx, requestCtx) {
      if (requestMetadata(request, requestCtx).skipInflight) return;

      const signal = request.signal ?? requestCtx?.signal;
      if (signal && !options.allowAbortSignal) return;
      if (!shouldDedupe(request, requestCtx)) return;

      const identity = requestCtx?.state[AUTH_IDENTITY_STATE_KEY];
      let authenticated = requestCtx?.state["@hyperttp/auth.applied"] === true;
      try {
        const input = request.input as { headers?: HeadersInit } | null;
        const headers = new Headers(input?.headers);
        authenticated ||= ["authorization", "proxy-authorization", "cookie", "x-api-key"].some(
          (name) => headers.has(name),
        );
      } catch {
        // Unknown header representations cannot safely participate in deduplication.
        return;
      }
      if (authenticated && (typeof identity !== "string" || !identity)) return;
      // Default URL keys may contain query credentials. Auth requires an explicit safe key.
      if ((authenticated || identity !== undefined) && !options.keyExtractor) return;

      const key = keyExtractor(request, requestCtx);
      if (key === undefined) return;

      let flights = inflight.get(identity);
      const existing = flights?.get(key);
      const lifecycleCtx: LifecycleContext | undefined = requestCtx;
      if (existing) {
        return waitForEntry(existing, signal, (response) => {
          const cloned = safeClone(response);
          return existing.usesSettlement && typeof lifecycleCtx?.acceptFinalResponse === "function"
            ? lifecycleCtx.acceptFinalResponse(cloned)
            : cloned;
        });
      }

      let resolve!: (response: UniversalResponse<TOutput>) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<UniversalResponse<TOutput>>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      // The primary request may fail without any duplicate awaiting this promise.
      // Observe rejection without replacing the original promise used by followers.
      void promise.catch(() => {});
      const usesSettlement = typeof lifecycleCtx?.onSettled === "function";
      const entry = { promise, resolve, reject, key, identity, usesSettlement };
      if (!flights) {
        flights = new Map();
        inflight.set(identity, flights);
      }
      flights.set(key, entry);
      const primaryKey = requestCtx ?? request;
      primaryFlights.set(primaryKey, entry);
      if (usesSettlement) {
        lifecycleCtx?.onSettled?.((outcome) => settle(primaryKey, entry, outcome));
      } else {
        legacyKeys.set(request, primaryKey);
      }
    },
    onResponse(response, request, _pluginCtx, requestCtx): void {
      const key = requestCtx ?? (request && (legacyKeys.get(request) ?? request));
      const entry = key && primaryFlights.get(key);
      if (!key || !entry || entry.usesSettlement) return;
      settle(key, entry, { ok: true, response });
    },
    onError(error, request, _pluginCtx, requestCtx): void {
      const key = requestCtx ?? (request && (legacyKeys.get(request) ?? request));
      const entry = key && primaryFlights.get(key);
      if (!key || !entry || entry.usesSettlement) return;
      settle(key, entry, { ok: false, error });
    },
  };
}
