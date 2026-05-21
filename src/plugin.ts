import type {
  HyperCore,
  HyperPlugin,
  InternalRequest,
  HttpClientOptions,
} from "@hyperttp/core";

export function withInflight(client: HyperCore): HyperCore {
  const inflight = new Map<string, Promise<unknown>>();
  const next = client.dispatch.bind(client);

  client.dispatch = async <T = any>(req: InternalRequest): Promise<T> => {
    if (!req.isGet || req.meta?.skipInflight) return next(req) as T;

    const urlString = typeof req.url === "string" ? req.url : req.url.getURL();
    if (inflight.has(urlString)) return inflight.get(urlString)! as T;

    const promise = next(req).finally(() => {
      inflight.delete(urlString);
    });

    inflight.set(urlString, promise);
    return promise as T;
  };
  return client;
}

declare module "@hyperttp/core" {
  interface HyperttpPluginsExtension {
    inflight?: { enabled: boolean };
  }
}

export const InflightPlugin: HyperPlugin = {
  name: "hyperttp-inflight",
  phase: "PREPARE",
  enabled: (config: HttpClientOptions) => config.inflight?.enabled !== false,
  apply: (client: HyperCore) => withInflight(client),
};
