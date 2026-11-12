# SMS providers (settings, adapters, sealed keys)

Decision (2026-11-12): every client or instance has a different SMS provider, so the provider is always an **adapter** behind a port, and each client connects theirs and enters its credentials **on the screen** under *Settings and configuration > SMS Providers* (`/admin/settings/sms`, permission `sms:manage`). Nothing about a provider is set in environment variables except the one data-encryption key that already seals every credential (`DATA_ENCRYPTION_KEY`).

## Pieces

- **Port** `server/ports/sms.ts`: `SmsPort.send({ to, text })` returning the provider's message id; `SmsSendError` carries words safe to show and whether trying again could help (`retry`). Domain code depends on this only.
- **Provider definitions** `lib/sms-providers.ts` (pure): for each provider id (`africastalking`, `twilio`, `log`) its name, summary and **fields** (label, whether secret, required, hint, pattern, length). The Settings form is drawn from this list, `checkProvider` validates against it on the server, and the lookup source `sms-providers` (a `staticSource`, so the provider choice is a ChoicePicker, never a `<select>`) lists it. Also `internationalPhone` (Kenyan numbers written with +254; other countries need their +) and `maskedPhone`.
- **Adapters** `server/adapters/sms/`: `AfricasTalkingSms` (form POST, `apiKey` header, sandbox host for username `sandbox`, status codes 100 to 102 accepted, the rest mapped to plain words), `TwilioSms` (basic auth, `From` or `MessagingServiceSid`), `LogSms` (writes a masked line to the server log and sends nothing, for trying the flow). `smsAdapter(id, settings, secrets)` builds one and returns null when something it needs is missing, so a half-set account is never used. Only fixed provider hosts are called (no client-supplied URL, so no SSRF), with a 10 second limit and no redirects. The provider's own error text is never repeated; refusals become sentences.
- **Table** `sms_provider_accounts` (migration 0163): name (unique per company, case-insensitive), adapter, plain `settings` jsonb, `secrets_sealed` (AES-GCM through `payments/crypto`, the same sealing as payment and courier credentials), `is_default` (partial unique index: one per company; check: a default is active), `is_active`, last test (when, ok, plain error; the number is not kept), `version`.
- **Service** `domains/sms/accounts.ts` `SmsAccounts`: `list`, `create` (the first connection becomes the default), `update` (what the request leaves out stays as saved; an empty secret keeps the saved one; changing a credential clears the last test), `setActive` (stopping the default clears the default), `setDefault` (active only), `sendTest`, and `defaultSender(companyId)` which returns an `SmsPort` or null. Changes to a company's connections take turns under an advisory lock so two at once cannot make two defaults; every change is versioned and written to the decision log with the *names* of the fields that changed, never their values.
- **Actions** `domains/sms/actions.ts` through `runSetting('sms:manage')`; **screen** `SmsProvidersClient`.

## Safety

Keys are sealed on save, opened only in `SmsAccounts.open` when a message is sent, and never returned by any view, action or log (a test checks the row, the view and the decision log). The test message has fixed text and is limited to one per connection every 30 seconds, so the button cannot be used to send anything else or to run up a bill. Every query is company-scoped; ids from the browser are checked.

## Adding a provider

Add its id to `SMS_PROVIDER_IDS` and its fields to `SMS_PROVIDERS`, write the adapter in `server/adapters/sms/`, add it to `smsAdapter`, and extend the check constraint in a migration. The screen, the lookup, validation and sealing need no change.

## Verified

Unit tests for the provider definitions and phone numbers and for each adapter against a fake provider (request shape, plain-word refusals, unreachable provider); 10 database tests (first is default, sealed key, validation and duplicate names, keep or replace the key, one default, concurrent creates, the fixed test text and number, rate limit, plain refusals, trial provider, company scoping); browser tests on desktop and phone.

## Not built

The default sender is used by lateness texts (delivery-module.md §61). Customer messages by text, and other events, are not built. A real send through Africa's Talking or Twilio has not been exercised (no account); the request shapes follow their documentation and are held by tests against a fake. Delivery receipts from providers are not read.
