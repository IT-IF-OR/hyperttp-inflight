# @hyperttp/inflight

> English | [Русский](https://github.com/IT-IF-OR/hyperttp-inflight/tree/main/lang/ru)

Request collapsing and de-duplication plugin for Hyperttp.

## Features

- Deduplicates concurrent equivalent requests into one network request.
- Shares the resulting response with all waiting callers.
- Removes in-flight entries after completion or failure.
- Runs in the Core v2 `PREPARE` phase with no external runtime dependencies.

## Installation

```bash
npm install @hyperttp/inflight
# or
bun add @hyperttp/inflight
```

## Usage

```ts
import { HyperClient } from "hyperttp";
import { withInflight } from "@hyperttp/inflight";

const client = new HyperClient({
  plugins: [withInflight()],
});

const [first, second] = await Promise.all([
  client.get("https://api.example.com/data"),
  client.get("https://api.example.com/data"),
]);
```

Both callers receive the result of a single request. Configure the plugin with the options
provided by `InflightOptions`; set `enabled: false` to disable it.

## Core v2

The plugin uses protocol-neutral `SendRequest`, `UniversalResponse`, and `RequestContext` values.
Request data is read from protocol-specific `input` and `metadata`.

## Authentication and safe keys

All keys, including custom `keyExtractor` results, are isolated by the non-secret
`RequestContext.state["@hyperttp/auth.identity"]` value. Run authentication before
inflight deduplication and provide a stable, non-secret identity for authenticated
requests. Requests without an identity share the anonymous partition. Identity is
compared directly, not serialized; use a stable string identity across requests.

The default key is the REST URL. Headers and bodies are not serialized, but a URL
can itself contain credentials (query API keys or URL userinfo). For those requests,
provide a custom `keyExtractor` returning a credential-free resource key, retaining
all non-secret parameters that affect the response. Return `undefined` or use
`metadata.skipInflight: true` when a safe key cannot be formed. Never put tokens,
passwords, API keys, or serialized request objects into custom keys. Authentication
identity isolation is applied automatically to custom keys as well.

## License

MIT © dirold2
