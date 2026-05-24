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
  interface HttpClientOptions {
    inflight?: { enabled?: boolean };
  }
  interface HyperttpPluginsExtension {
    skipInflight?: boolean;
  }
}

function cloneResponse<T>(res: HttpResponse<T>): HttpResponse<T> {
  return {
    ...res,
    headers: { ...res.headers },
  };
}

export function withInflight(): HyperPlugin {
  const inflight = new Map<string, Promise<HttpResponse<any>>>();

  return {
    name: "hyperttp-inflight",
    phase: "PREPARE",
    enabled: (config: HttpClientOptions) => config.inflight?.enabled !== false,

    wrapDispatch: (next) => {
      return <T>(req: InternalRequest): Promise<HttpResponse<T>> => {
        const inflightReq = req as InflightRequest;

        if (inflightReq.method !== "GET" || inflightReq.meta?.skipInflight) {
          return next<T>(req);
        }

        const cacheKey = inflightReq.url;
        const sharedPromise = inflight.get(cacheKey) as
          | Promise<HttpResponse<T>>
          | undefined;

        if (sharedPromise !== undefined) {
          const signal = inflightReq.signal;

          if (signal?.aborted) {
            return Promise.reject(
              new DOMException("The user aborted a request.", "AbortError"),
            );
          }

          if (signal) {
            return new Promise<HttpResponse<T>>((resolve, reject) => {
              let clean = false;

              const onAbort = () => {
                if (clean) return;
                clean = true;
                reject(
                  new DOMException("The user aborted a request.", "AbortError"),
                );
              };

              signal.addEventListener("abort", onAbort);

              sharedPromise.then(
                (res) => {
                  if (!clean) {
                    clean = true;
                    signal.removeEventListener("abort", onAbort);
                    resolve(cloneResponse(res));
                  }
                },
                (err) => {
                  if (!clean) {
                    clean = true;
                    signal.removeEventListener("abort", onAbort);
                    reject(err);
                  }
                },
              );
            });
          }

          return sharedPromise.then(cloneResponse);
        }

        const promise = next<T>(inflightReq).then(
          (res) => {
            inflight.delete(cacheKey);
            return res;
          },
          (err) => {
            inflight.delete(cacheKey);
            throw err;
          },
        );

        inflight.set(cacheKey, promise);
        return promise;
      };
    },
  };
}
