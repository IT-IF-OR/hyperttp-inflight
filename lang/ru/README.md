# @hyperttp/inflight

> [English](https://github.com/IT-IF-OR/hyperttp-inflight) | Русский

Плагин схлопывания и дедупликации запросов для Hyperttp.

## Возможности

- Объединяет параллельные эквивалентные запросы в один сетевой запрос.
- Передаёт результат всем ожидающим callers.
- Удаляет записи о выполняющихся запросах после успеха или ошибки.
- Работает на фазе `PREPARE` Core v2 без runtime-зависимостей.

## Установка

```bash
npm install @hyperttp/inflight
# или
bun add @hyperttp/inflight
```

## Использование

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

Оба вызова получают результат одного сетевого запроса. Настройки передаются через
`InflightOptions`; для отключения используйте `enabled: false`.

## Core v2

Плагин использует protocol-neutral значения `SendRequest`, `UniversalResponse` и
`RequestContext`. Данные запроса читаются из protocol-specific `input` и `metadata`.

## Лицензия

MIT © dirold2
