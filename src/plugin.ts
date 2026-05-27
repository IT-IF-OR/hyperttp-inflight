import type {
  HyperPlugin,
  InternalRequest,
  HttpClientOptions,
  HttpResponse,
  HyperttpError,
} from "@hyperttp/types";

/**
 * @ru Расширенный интерфейс запроса с поддержкой мета-флагов дедупликации.
 * @en Extended request interface supporting de-duplication meta flags.
 */
export interface InflightRequest extends InternalRequest {
  meta?: InternalRequest["meta"] & {
    skipInflight?: boolean;
  };
}

declare module "@hyperttp/types" {
  interface HttpClientOptions {
    inflight?: { enabled?: boolean };
  }
  interface HyperttpPluginsExtension {
    skipInflight?: boolean;
  }
}

interface InflightEntry {
  promise: Promise<HttpResponse<any>>;
  resolve: (res: HttpResponse<any>) => void;
  reject: (err: any) => void;
  url: string;
}

/**
 * @private
 * @ru Поверхностно клонирует объект ответа для безопасного распределения между независимыми подписчиками.
 * @en Shallow clones the response object for safe distribution among independent subscribers.
 * @param res - Target HTTP response to clone.
 * @returns Cloned response instance.
 */
function cloneResponse<T>(res: HttpResponse<T>): HttpResponse<T> {
  return {
    ...res,
    headers: { ...res.headers },
  };
}

/**
 * @ru Плагин дедупликации одновременно выполняющихся GET-запросов (Inflight Request Pooling).
 * @en Concurrent identical GET request de-duplication plugin (Inflight Request Pooling).
 * @returns HyperPlugin object instance.
 */
export function withInflight(): HyperPlugin {
  /**
   * @ru Карта активных сетевых полетов, проиндексированная по URL запроса.
   * @en Map of active network flights indexed by request URL.
   */
  const inflight = new Map<string, InflightEntry>();

  /**
   * @ru Карта связи первичных запросов с их управляющими триггерами обещаний.
   * @en Map linking primary requests to their controlling promise triggers.
   */
  const primaryFlights = new WeakMap<InternalRequest, InflightEntry>();

  return {
    name: "hyperttp-inflight",

    /**
     * @ru Проверяет активацию плагина. По умолчанию включен, если явным образом не передано `enabled: false`.
     * @en Evaluates plugin activation. Enabled by default unless explicitly set to `enabled: false`.
     */
    enabled: (config: HttpClientOptions): boolean =>
      config.inflight?.enabled !== false,

    /**
     * @ru Перехватывает запрос. Если аналогичный GET уже выполняется, возвращает управляемый Promise для склейки.
     * @en Intercepts the request. If a matching GET is running, returns a managed Promise to share the flight.
     */
    async onRequest(req: InternalRequest): Promise<HttpResponse<any> | void> {
      const inflightReq = req as InflightRequest;

      if (inflightReq.method !== "GET" || inflightReq.meta?.skipInflight) {
        return;
      }

      const cacheKey = inflightReq.url;
      const existing = inflight.get(cacheKey);

      if (existing !== undefined) {
        const { signal } = inflightReq;

        if (signal?.aborted) {
          throw new DOMException("The user aborted a request.", "AbortError");
        }

        if (signal) {
          return new Promise<HttpResponse<any>>((resolve, reject) => {
            let clean = false;

            const onAbort = () => {
              if (clean) return;
              clean = true;
              reject(
                new DOMException("The user aborted a request.", "AbortError"),
              );
            };

            signal.addEventListener("abort", onAbort);

            existing.promise.then(
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

        return existing.promise.then(cloneResponse);
      }

      let resolveFn!: (res: HttpResponse<any>) => void;
      let rejectFn!: (err: HyperttpError) => void;

      const promise = new Promise<HttpResponse<any>>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });

      const entry: InflightEntry = {
        promise,
        resolve: resolveFn,
        reject: rejectFn,
        url: cacheKey,
      };

      inflight.set(cacheKey, entry);
      primaryFlights.set(req, entry);

      return;
    },

    /**
     * @ru Обрабатывает успешный ответ мастер-запроса, рассылая результат всем ожидавщим дубликатам.
     * @en Handles successful primary response, broadcasting the result to all awaiting duplicates.
     */
    onResponse(res: HttpResponse<any>, req: InternalRequest): void {
      const entry = primaryFlights.get(req);
      if (entry !== undefined) {
        entry.resolve(res);
        primaryFlights.delete(req);

        if (inflight.get(entry.url) === entry) {
          inflight.delete(entry.url);
        }
      }
    },

    /**
     * @ru Обрабатывает ошибку сети мастер-запроса, транслируя исключение во все заблокированные конвейеры.
     * @en Handles primary network error, broadcasting the failure exception to all stalled pipelines.
     */
    onError(err: HyperttpError, req: InternalRequest): void {
      const entry = primaryFlights.get(req);
      if (entry !== undefined) {
        entry.reject(err);
        primaryFlights.delete(req);

        if (inflight.get(entry.url) === entry) {
          inflight.delete(entry.url);
        }
      }
    },
  };
}
