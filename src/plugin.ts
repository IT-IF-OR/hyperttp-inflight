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

interface InflightEntry<TOutput> {
  promise: Promise<UniversalResponse<TOutput>>;
  resolve: (response: UniversalResponse<TOutput>) => void;
  reject: (error: unknown) => void;
  key: InflightKey;
  identity: unknown;
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
  const primaryFlights = new WeakMap<SendRequest<TInput>, InflightEntry<TOutput>>();
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

      const key = keyExtractor(request, requestCtx);
      if (key === undefined) return;

      const identity = requestCtx?.state[AUTH_IDENTITY_STATE_KEY];
      let flights = inflight.get(identity);
      const existing = flights?.get(key);
      if (existing) return waitForEntry(existing, signal, safeClone);

      let resolve!: (response: UniversalResponse<TOutput>) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<UniversalResponse<TOutput>>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      // The primary request may fail without any duplicate awaiting this promise.
      // Observe rejection without replacing the original promise used by followers.
      void promise.catch(() => {});
      const entry = { promise, resolve, reject, key, identity };
      if (!flights) {
        flights = new Map();
        inflight.set(identity, flights);
      }
      flights.set(key, entry);
      primaryFlights.set(request, entry);
    },
    onResponse(response, request): void {
      const entry = request && primaryFlights.get(request);
      if (!entry) return;
      entry.resolve(response);
      primaryFlights.delete(request);
      const flights = inflight.get(entry.identity);
      if (flights?.get(entry.key) === entry) flights.delete(entry.key);
      if (flights?.size === 0) inflight.delete(entry.identity);
    },
    onError(error, request): void {
      const entry = request && primaryFlights.get(request);
      if (!entry) return;
      entry.reject(error);
      primaryFlights.delete(request);
      const flights = inflight.get(entry.identity);
      if (flights?.get(entry.key) === entry) flights.delete(entry.key);
      if (flights?.size === 0) inflight.delete(entry.identity);
    },
  };
}
