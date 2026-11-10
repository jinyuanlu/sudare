# Contributing

## Working on it

```bash
pnpm install
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

The server tests run in workerd and need no Cloudflare account. `pnpm dev` runs the whole
thing locally; `pnpm e2e` drives it in a browser (see `e2e/smoke.cjs`).

## Rules of the codebase

- **Rules live in the pure core.** Anything that decides whether a write is allowed belongs
  in `decide` (`packages/protocol/src/conv.ts`) or `transition` (`inbox.ts`), not in a
  route or a Durable Object. The Worker derives *which gate* a request came through from
  its credential and passes that in; it never takes it from the request body.
- **State is a fold of a log.** Do not add a writable field for something that can be
  derived from events. If a new state change is needed, add an event.
- **A changed guard changes three things:** the code, a property or integration test that
  fails without it, and `spec/Sudare.tla` if the guard is modelled there.
- **Clients are not a security boundary.** A check that exists only in the web app or the
  plugin does not count.
- **Errors are codes** from `ERROR_CODES`, never prose to be matched.
- No new runtime dependency without a reason stated in the pull request.

## Pull requests

Keep them small and say which invariant (I1 to I12 in the README), if any, the change
touches. CI must pass: typecheck, tests, and the TLA+ model check.

## Licensing of contributions

The plugin is MIT; everything else is FSL-1.1-MIT (see the README). By submitting a
contribution you agree that it is licensed under the license of the part of the repository
it changes, and you grant the project's copyright holder a perpetual, worldwide,
non-exclusive, royalty-free right to use and relicense your contribution as part of the
project. You confirm you have the right to submit it.
