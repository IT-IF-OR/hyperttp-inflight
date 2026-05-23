import type {
  HyperPlugin,
  InternalRequest,
  HttpClientOptions,
  HttpResponse,
} from "@hyperttp/core";

export interface InflightRequest extends InternalRequest {
  meta?: InternalRequest["meta"] & {
    skipInflight?: boolean;
  };
}

declare module "@hyperttp/core" {
  interface HyperttpPluginsExtension {
    inflight?: { enabled?: boolean };
    skipInflight?: boolean;
  }
}

export function withInflight(): HyperPlugin {
  const inflight = new Map<string, Promise<HttpResponse<any>>>();

  return {
    name: "hyperttp-inflight",
    phase: "PREPARE",
    enabled: (config: HttpClientOptions) => config.inflight?.enabled !== false,

    wrapDispatch: (next) => {
      return async <T>(req: InternalRequest): Promise<HttpResponse<T>> => {
        const inflightReq = req as InflightRequest;

        if (inflightReq.method !== "GET" || inflightReq.meta?.skipInflight) {
          return next<T>(req);
        }

        const urlKey = inflightReq.url;

        if (inflight.has(urlKey)) {
          const sharedPromise = inflight.get(urlKey) as Promise<
            HttpResponse<T>
          >;

          if (inflightReq.signal) {
            if (inflightReq.signal.aborted) {
              throw new DOMException(
                "The user aborted a request.",
                "AbortError",
              );
            }

            return new Promise<HttpResponse<T>>((resolve, reject) => {
              const onAbort = () =>
                reject(
                  new DOMException("The user aborted a request.", "AbortError"),
                );
              inflightReq.signal!.addEventListener("abort", onAbort);

              sharedPromise.then(
                (res) => {
                  inflightReq.signal!.removeEventListener("abort", onAbort);
                  resolve(res);
                },
                (err) => {
                  inflightReq.signal!.removeEventListener("abort", onAbort);
                  reject(err);
                },
              );
            });
          }

          return sharedPromise;
        }

        const promise = next<T>(inflightReq).finally(() => {
          inflight.delete(urlKey);
        });

        inflight.set(urlKey, promise);
        return promise;
      };
    },
  };
}
