# Contributing to Rekey

Thanks for your interest in Rekey — a self-hostable, multi-tenant auth +
billing backend. This guide covers local setup, the dev loop, and how to get a
change merged.

For the system design, see [ARCHITECTURE.md](ARCHITECTURE.md). AI coding agents
should also read [AGENTS.md](AGENTS.md).

## Prerequisites

- **Node.js 22+** (matches `engines` in the root `package.json`)
- **pnpm 9+** (`corepack enable` will provide it)
- **Docker** (for Postgres + Redis; or bring your own)

## Local setup

```bash
git clone https://github.com/rekey-dev/rekey.git
cd rekey
pnpm install

# Configure — the API refuses to boot without the required secrets.
cp .env.example .env
#   Generate each with: openssl rand -hex 32 (24 for the datastore passwords)
#   Required by the API:     DATABASE_URL, JWT_SECRET (≥32), SUPER_ADMIN_KEY (≥32)
#   Required by compose:     POSTGRES_PASSWORD, REDIS_PASSWORD — then paste both
#                            into DATABASE_URL / REDIS_URL by hand
#   Required in production:  ENCRYPTION_KEY (64 hex chars)

# Start the datastores (Postgres + Redis) and apply migrations.
docker compose up -d postgres redis
pnpm db:migrate:deploy

# Run everything in watch mode.
pnpm dev
```

`pnpm db:migrate:deploy` and `pnpm dev` both read that root `.env`, and
`pnpm dev` generates the Prisma client and builds the workspace packages the
apps import from `dist/` before starting anything — a fresh clone needs no
separate build step. Running an app's own `dev` script directly (`pnpm --filter
@rekey.dev/api dev`) does none of that, and does not read `.env` either.

- API: `http://localhost:3030` — interactive docs at `/docs`
- Operator panel: `http://localhost:3031`

Redis is required infrastructure, not just a rate-limiter: the outbound-webhook
delivery queue runs on it and the API refuses to start if Redis is unreachable.

### Run the whole stack in Docker

Instead of `pnpm dev`, you can boot the full stack (Postgres + Redis + API +
panel + portal) with one command — the API auto-migrates on start:

```bash
cp .env.example .env                  # fill the required secrets
docker compose --profile full up      # add --build after changing app code
```

The `full` profile is what pulls in the API, the panel and the portal; a bare
`docker compose up` starts only Postgres and Redis, which is the right thing
when you are running the apps from your shell.

Every published port binds to `127.0.0.1` unless you set `BIND_ADDRESS`, so this
stack is not reachable from outside the machine even on a remote host.

### Create your first tenant

With the API running, use the bootstrap admin key (`SUPER_ADMIN_KEY`) to create
a Tenant and Application. See [docs/quickstart.md](docs/quickstart.md) for the
end-to-end walkthrough (boot → Tenant → Application → API key → first call).

## Dev loop

| Command | What |
|---|---|
| `pnpm dev` | run all apps in watch mode |
| `pnpm build` | build every workspace |
| `pnpm test` | run the vitest suites |
| `pnpm typecheck` | typecheck all workspaces |
| `pnpm db:migrate` | create + apply a dev migration |
| `pnpm db:studio` | open Prisma Studio |

Before opening a PR, make sure `pnpm build`, `pnpm typecheck`, and `pnpm test`
pass. The `apps/api` suite shares one Postgres + Redis in a single fork, so a
cross-file failure is sometimes transient — re-run before assuming a regression.

### Root files and the turbo cache

`turbo.json` declares `globalDependencies`. Anything at the repo root that
packages read *through* — `tsconfig.base.json`, `prisma/schema.prisma`, the
migrations — belongs in that list, because turbo hashes each package's own files
and would otherwise never see those change.

The failure it prevents is quiet: tighten a compiler option in
`tsconfig.base.json`, which every app extends, and `turbo typecheck` replays a
cached PASS produced under the old setting. The check reports success without
having run against the change that was the point of making it.

If you add a root file that packages depend on, add it there. Verify with
`turbo run typecheck --filter=<pkg> --dry` — edit the file and the task `Hash`
must change.

### Tests are typechecked

`pnpm typecheck` in `apps/api` runs twice: `tsconfig.json` for `src`, and
`tsconfig.test.json` for `src` + `test` + `test-providers` + `scripts`. CI runs
the same script through turbo, so a type error in a test fails the build.

This is not tidiness. Vitest transpiles without checking types, so before this
a test could call a function with the wrong arguments and still pass — the
runtime just saw `undefined`. One had: a security test minted an MFA challenge
token without the `tokenGeneration` argument, so the token's signature did not
verify and the 401 it asserted came from the signature check, never reaching the
`typ` claim the test was named for. It passed while proving nothing.

If you add a file outside those globs, add it to `tsconfig.test.json` too.

### The test database

**The suite is destructive.** It applies migrations to whatever database it is
pointed at and runs `TRUNCATE ... RESTART IDENTITY CASCADE` between test files.
Never aim it at a database you want to keep.

It resolves the target in this order:

1. `TEST_DATABASE_URL`
2. `postgresql://rekey:rekey@localhost:5432/rekey_test?schema=public`

`DATABASE_URL` is **not** consulted, on purpose. It names your development
database, and honouring it meant `pnpm test` could migrate and repeatedly empty
it with no warning.

Two guards, because both of these have actually happened:

- The database name must end in `_test`, or setup refuses before touching it.
- If migrations fail on the built-in default, the error says so and suggests the
  likely cause rather than passing Prisma's `P1000` through.

That second one matters if you run more than one project. Port 5432 is the
default for *every* Postgres, so the built-in URL can reach an unrelated
project's server, and Prisma reports it as a credentials problem — which sends
you off to fix a password on a database that was never the right target. Check
what is actually holding the port:

```bash
docker ps --format '{{.Names}}\t{{.Ports}}'
```

and set `TEST_DATABASE_URL` to the right host and port if Rekey's Postgres is
published somewhere other than 5432.

**Do not run two suites against one database at the same time.** They share it,
and each truncates between files, so concurrent runs delete each other's rows
and fail in ways that look like real bugs in whichever code you happened to be
editing.

**Linting.** `pnpm lint` runs ESLint across every workspace from one flat
config at the repo root (`eslint.config.mjs`). CI runs it and **errors fail the
build**; warnings do not.

Warnings are grandfathered rather than blocking. There are 58 of them, and
forcing that to zero on day one would have meant either a huge unrelated diff or
a rule set watered down until it caught nothing. What stops the number growing
is the pre-commit hook: `lint-staged` runs ESLint with `--max-warnings=0` over
the files your commit touches, so anything you edit comes back clean.

`pnpm lint:fix` applies the safe fixes. It passes
`--fix-type problem,suggestion,layout`, which deliberately excludes `directive`:
a plain `eslint --fix` DELETES `eslint-disable` comments whose rule is not
enabled, silently discarding the reason somebody wrote down.

Two rules earn special mention. `local/no-em-dash` is a repo-local rule that
bans em and en dashes in comments and user-facing error strings, because they
read as machine-written and this codebase ships publicly. And
`@typescript-eslint/no-floating-promises` runs type-aware over `apps/api`: this
codebase calls `void recordSecurityEvent(...)` by contract, and a dropped
`void` or a missing `await` on a money path is invisible without it.

`@typescript-eslint/no-unnecessary-type-assertion` is deliberately **off**. Its
autofix removed `as object` from a Prisma write where the assertion was
load-bearing for `InputJsonValue` assignability, producing ten typecheck errors
from a single `--fix` run.

## Pull requests

1. Fork and branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep the change focused; add or update tests next to the code you touch.
3. Conventional-commit style is appreciated (`feat:`, `fix:`, `docs:`, `chore:`).
4. Describe the change and how you verified it. Link any related issue.
5. CI runs build + typecheck + tests + the config guards on every PR.

A few invariants worth knowing before you touch auth or billing (full list in
ARCHITECTURE.md §6):

- The two auth stacks (`modules/auth` for end-users, `modules/tenant-auth` for
  operators) are parallel — a fix in one usually needs mirroring in the other.
- Every JWT carries a `typ` claim; verifiers reject the wrong type.
- Billing state transitions happen in webhook handlers, never in the request
  that starts checkout.
- Credentials are stored hashed (SHA-256) or encrypted (AES-256-GCM), never in
  the clear.

## Deploying

Rekey is a self-hostable monolith — `docker compose --profile full up` boots the
whole stack locally. For a production deployment (Traefik + TLS, env template,
migrations), see **[DEPLOY.md](DEPLOY.md)**, which uses `docker-compose.prod.yml`
rather than this file.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
