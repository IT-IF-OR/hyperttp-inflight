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

## License

MIT © dirold2
