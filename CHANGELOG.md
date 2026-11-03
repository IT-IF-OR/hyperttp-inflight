# Changelog

## [3.0.1] - 2026-11-03

- Require `@hyperttp/types@^0.5.0` and validate against the registry declarations.
- Use shared RequestContext/RequestOutcome contracts instead of local settlement interface duplicates.

## [3.0.0] - 2026-11-03

### Changed

- **Breaking:** Updated the `@hyperttp/types` peer and development dependency to `^0.5.0`.
- Integrated optional `RequestContext.onSettled` to keep primary flights registered until final success or failure, including response transformations and cancellation.
- Followers now receive shallow response/header clones of the final result and use optional `acceptFinalResponse` to avoid applying response transformations twice.

### Fixed

- Tracked primary flights by stable request context so replacing a request does not lose its inflight entry.
- Prevented intermediate response/error hooks from settling flights when final lifecycle settlement is available.

### Documentation

- Documented final lifecycle integration and legacy fallback to response/error hooks when `onSettled` is unavailable; without `acceptFinalResponse`, followers retain the previous response pipeline behavior.

## [2.0.5] - 2026-11-02

### Fixed

- Bypassed inflight deduplication for requests marked by `@hyperttp/auth.applied` or carrying recognized authentication headers unless a non-empty string authentication identity is available, including when using custom keys.
- Required an explicit credential-free `keyExtractor` for requests with authentication or auth identity instead of using potentially credential-bearing default URL keys.
- Skipped deduplication when request headers cannot be safely parsed.

### Documentation

- Documented conservative authentication defaults, auth-before-inflight ordering, and limitations when detecting manually supplied query or nonstandard header credentials.

## [2.0.4] - 2026-11-02

### Fixed

- Partitioned all inflight keys, including custom extractors, by non-secret authentication identity without serializing identity or request credentials.

### Documentation

- Documented safe custom keys for URLs containing query credentials and the requirement to disable deduplication when a safe key cannot be formed.

## [2.0.3] - 2026-11-02

### Fixed

- **Critical:** Fixed default REST inflight deduplication sharing requests across identities by partitioning keys by the non-secret `@hyperttp/auth.identity` request state.

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
