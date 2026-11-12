# Repository Guidelines

Setup, commands and the top-level layout are documented in [README.md](README.md). Product behavior lives under `docs/`; [docs/README.md](docs/README.md) is the index. Keep this file limited to working rules and link elsewhere instead of restating behavior.

## Working rules

- Contract first: edit `packages/contracts/openapi.yaml`, then run `npm run contracts:generate`. Never edit `packages/contracts/src/schema.d.ts` by hand.
- Go request/response structs are hand-written. When the Agent payload changes, update `packages/contracts/fixtures` and the contract test in `apps/agent/internal/reporter`.
- Migrations are append-only: add `migrations/NNNN_*.sql`. Apply them locally before running Worker tests.
- Respect the Worker layering in [docs/architecture.md](docs/architecture.md): SQL stays in `repositories/`, business rules in `services/`, HTTP handling in `routes/`. New resources get their own route and service module mounted with Hono `.route()`.
- Apply the secret rules in [docs/security.md](docs/security.md): D1 stores token hashes only, the REALITY private key stays on the node, and logs never contain tokens, subscription URLs, UUIDs or request bodies.
- Agent tests use fakes and must not require network access, a running Xray or root.

## Documentation

- One topic per file under `docs/`. Cross-module decisions belong to `architecture.md`; subsystem rules belong to the file that owns the behavior.
- Update the owning file in the same change and link between files instead of copying paragraphs.
- Describe current behavior only. Remove superseded plans, draft states and change history.

## Verification

Run the verification commands in [README.md](README.md#校验) before finishing.
