# Changelog

## [2.0.2] - 2026-10-20

### Fixed

- Partitioned default REST inflight-deduplication keys by the non-secret `@hyperttp/auth.identity` request state.
- Forwarded `RequestContext` to the default key extractor so request-scoped identity is available when forming the key.
- Updated the `@hyperttp/types` peer and development dependency to `^0.4.2`.

## [2.0.0] - 2026-08-22

### Changed

- **Breaking:** Migrated the inflight deduplication plugin to the Core v2 universal request/response envelope.
- **Breaking:** Updated the `@hyperttp/types` peer dependency to `^0.3.0`.
- Inflight hooks now operate on protocol-neutral `SendRequest`, `UniversalResponse`, and `RequestContext` values.
- Request identity and response data now follow the Core v2 `input`, `metadata`, and `data` envelope fields.
