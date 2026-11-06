# Commit scopes

Use exactly one of these scopes in every Conventional Commit (`type(scope): summary`).

| Scope | Covers |
|---|---|
| `api` | `apps/api`: Symfony API, OAuth2 server, domain, migrations |
| `sync` | `apps/sync`: Go sync workers |
| `web` | `apps/web`: Vue web client |
| `desktop` | `apps/desktop`: Tauri desktop shell |
| `mobile` | `apps/mobile`: Expo app |
| `website` | `apps/website`: the marketing site at gettresso.com |
| `core` | `packages/core`: shared TypeScript |
| `infra` | `compose.yaml`, `docker/`, CI and deployment |
| `docs` | `docs/`, README files |
| `repo` | Workspace-wide changes: root config, tooling, changes spanning many apps |
