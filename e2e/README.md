# End-to-end tests

Playwright, in the Chrome installed on the machine, at a desktop width and at a phone width (`pnpm test:e2e`). The run builds its own
copy of the app, on its own port, against its own database, and seeds it (`e2e/support/seed.ts`) before the first test.

```
E2E_DATABASE_URL=postgres://user:pass@127.0.0.1:5434/qsell_e2e pnpm test:e2e [e2e/some.spec.ts] [--project=desktop]
```

The database name must contain `e2e` (never the development database) and must be new for each run: some rules refuse repeats on purpose.
`E2E_PORT` changes the port (default 3100).

## Things that cost time before, so they are written down

- **Do not run it beside your own `next dev` in the same folder.** Both servers write `next-env.d.ts` and `tsconfig.json`, each sees the
  other's write and rebuilds, and the page under test reloads over and over (the console shows "Fast Refresh rebuilding" again and again).
  Run from a copy of the repo (`rsync` it without `.next*`, `node_modules` and `.git`, then `cp -al node_modules`), or stop your dev server.
- **A first visit to a route can reload the page** while the development server compiles it, and a reload empties anything typed. Tests wait
  for the page (`open`, `followLink` in `e2e/support/page.ts`) and tap a link once; do not tap again and again, because a second tap
  stacks another navigation. `clickUntilVisible` is only for a button that was not yet wired up on a page that is already there.
- **Seed rows go through the services, not into the tables.** The nightly integrity check compares every ledger entry with its detailed
  entries. A row written straight into `customer_ledger_entries` has no opening entry, so the check raised "customer ledger drift"
  on every run. Use `container.finance.customerLedger.addEntry`. The seed ends with `assertBooksAgree`, which fails and names the entry.
- **One shard has 22 minutes** (`globalTimeout` in `playwright.config.ts`, CI only) and the suite runs on `E2E_SHARDS` shards in
  `.github/workflows/ci-cd.yml`. The two numbers in that workflow (`E2E_SHARDS` and the `matrix.shard` list) must match. A shard that is
  cut off reports its last test as "Test ended" and the rest as skipped, which looks like a failure of that test but is not. When the suite
  grows, add shards first: tests take about 13 seconds each, so a shard should hold well under 100 of them.

## Helpers (`e2e/support`)

`open` (waits for a screen and its wiring), `followLink` (one tap on a link that changes page), `clickUntilVisible`, `noHorizontalScroll`,
`noInnerHorizontalScroll`, `noNativeSelect`. Fixtures run as small tools (`delivery-fixtures`, `rider-fixtures`, `stock-fixtures`,
`clerk-fixture`: a member of staff who may see orders and write quotes but not update products).
