import type {
  HyperPlugin,
  InternalRequest,
  HttpClientOptions,
  HttpResponse,
  HyperttpError,
} from "@hyperttp/types";

/**
 * @en Extended internal request interface with inflight-specific metadata.
 * @ru Расширенный интерфейс внутреннего запроса с метаданными, специфичными для inflight.
 */
export interface InflightRequest extends InternalRequest {
  /**
   * @en Metadata including the option to skip inflight deduplication.
   * @ru Метаданные, включая опцию пропуска дедупликации inflight.
   */
  meta?: InternalRequest["meta"] & {
    /**
     * @en If true, bypasses the inflight deduplication logic for this request.
     * @ru Если true, обходит логику дедупликации inflight для этого запроса.
     */
    skipInflight?: boolean;
  };
}

/**
 * @en Extends HttpClientOptions to include inflight deduplication configuration.
 * @ru Расширяет HttpClientOptions, добавляя конфигурацию дедупликации inflight.
 */
declare module "@hyperttp/types" {
  interface HttpClientOptions {
    /**
     * @en Configuration for the inflight deduplication plugin.
     * @ru Конфигурация для плагина дедупликации inflight.
     */
    inflight?: { enabled?: boolean };
  }
}

/**
 * @en Structure representing a pending in-flight request promise and its resolvers.
 * @ru Структура, представляющая ожидающее выполнение обещание запроса и его разрешающие функции.
 */
interface InflightEntry {
  /**
   * @en The promise representing the in-flight request.
   * @ru Обещание, представляющее выполняющийся запрос.
   */
  promise: Promise<HttpResponse<any>>;

  /**
   * @en Resolver function for the promise.
   * @ru Функция разрешения обещания.
   */
  resolve: (res: HttpResponse<any>) => void;

  /**
   * @en Rejection function for the promise.
   * @ru Функция отклонения обещания.
   */
  reject: (err: any) => void;

  /**
   * @en The URL key used for deduplication.
   * @ru Ключ URL, используемый для дедупликации.
   */
  url: string;
}

/**
 * @en Creates a plugin for deduplicating concurrent identical GET requests (inflight caching).
 * Prevents multiple simultaneous requests to the same URL by sharing the same promise.
 * @ru Создает плагин для дедупликации одновременных идентичных GET-запросов (inflight кэширование).
 * Предотвращает множественные одновременные запросы к одному URL, разделяя одно и то же обещание.
 * @returns The configured HyperPlugin instance.
 */
export function withInflight(): HyperPlugin {
  const inflight = new Map<string, InflightEntry>();
  const primaryFlights = new WeakMap<InternalRequest, InflightEntry>();

  /**
   * @en Safely clones the response if possible, otherwise creates a shallow copy.
   * @ru Безопасно клонирует ответ, если возможно, иначе создает поверхностную копию.
   * @template T - Type of the response body.
   * @param res - The response to clone.
   * @returns A cloned or copied response object.
   */
  const safeClone = <T>(res: HttpResponse<T>): HttpResponse<T> => {
    return typeof res.clone === "function"
      ? res.clone()
      : { ...res, headers: { ...res.headers } };
  };

  return {
    name: "hyperttp-inflight",

    /**
     * @en Predicate to check if the inflight plugin is enabled. Enabled by default.
     * @ru Предикат для проверки включен ли плагин inflight. Включен по умолчанию.
     * @param config - The current client configuration.
     * @returns True if inflight deduplication is not explicitly disabled.
     */
    enabled: (config: HttpClientOptions): boolean =>
      config.inflight?.enabled !== false,

    /**
     * @en Intercepts outgoing requests to check for existing in-flight duplicates.
     * @ru Перехватывает исходящие запросы для проверки существующих выполняющихся дубликатов.
     * @param req - The internal request object.
     * @returns A shared promise if a duplicate exists, otherwise void to continue.
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
            let settled = false;

            const onAbort = () => {
              if (settled) return;
              settled = true;
              signal.removeEventListener("abort", onAbort);
              reject(
                new DOMException("The user aborted a request.", "AbortError"),
              );
            };

            signal.addEventListener("abort", onAbort);

            existing.promise
              .then((res) => {
                if (!settled) {
                  settled = true;
                  signal.removeEventListener("abort", onAbort);
                  resolve(safeClone(res));
                }
              })
              .catch((err) => {
                if (!settled) {
                  settled = true;
                  signal.removeEventListener("abort", onAbort);
                  reject(err);
                }
              });
          });
        }

        return existing.promise.then(safeClone);
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
     * @en Intercepts successful responses to resolve the shared in-flight promise.
     * @ru Перехватывает успешные ответы для разрешения общего обещания inflight.
     * @param res - The HTTP response object.
     * @param req - The original internal request object.
     */
    onResponse(res: HttpResponse<any>, req?: InternalRequest): void {
      if (!req) return;
      const entry = primaryFlights.get(req);
      if (entry) {
        entry.resolve(res);
        primaryFlights.delete(req);
        if (inflight.get(entry.url) === entry) inflight.delete(entry.url);
      }
    },

    /**
     * @en Intercepts errors to reject the shared in-flight promise.
     * @ru Перехватывает ошибки для отклонения общего обещания inflight.
     * @param err - The error object.
     * @param req - The original internal request object.
     */
    onError(err: HyperttpError, req?: InternalRequest): void {
      if (!req) return;
      const entry = primaryFlights.get(req);
      if (entry) {
        entry.reject(err);
        primaryFlights.delete(req);
        if (inflight.get(entry.url) === entry) inflight.delete(entry.url);
      }
    },
  };
}
