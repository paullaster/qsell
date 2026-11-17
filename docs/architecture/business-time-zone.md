# The business time zone: one company setting, kept in the database

**Status:** built 2026-11-17 (migration 0187). **Owner:** Settings (Business Time Zone), read by every module.

## 1. Why

"Today", "9 o'clock" and "the 1st of the month" depend on a time zone. The system had decided it in code: a constant, `DEFAULT_BUSINESS_TIMEZONE = 'Africa/Nairobi'`, plus about forty places that wrote `'Africa/Nairobi'` or `+03:00` themselves. A business anywhere else would have had its sales dated, its quiet hours for text messages, its delivery windows and its report days in the wrong zone, and could not have changed it without a developer. The zone is now **data**: a value on the company row, changed on a Settings screen by someone who has been given a permission for exactly that, with a reason, and recorded.

It is deliberately **not an environment value**: an environment value is the same for every deployment of an image and changes with a restart, not with a decision someone can be asked to explain.

## 2. Data

`company_settings.timezone` (text, not null, default `Africa/Nairobi`, so every existing company keeps behaving as before). A database check refuses any value that is not the shape of an IANA name (`Region/City`, `Region/Area/City`, `UTC`) or is longer than 64 characters, so no door can store something the system cannot read. Whether the runtime actually knows the zone is checked by the service (`isValidTimeZone`, which tries the zone in `Intl`; the runtime is what turns every instant into a day or an hour, so it is the test that matters). A bare offset or abbreviation (`EST`, `GMT+3`) is a choice nobody can resolve to a place and is refused.

## 3. Who may change it, and how

- Permission **`timezone:manage`** ("Change the business time zone"), category Company & Settings, given to the Admin role by default and to nobody else. It is checked on the server by the action (`runSetting`), by the zone picker's lookup source and by the reason picker's. The navigation link carries the same permission.
- `BusinessTimeService.set` in one transaction: reads the zone as typed (trimmed, refused in words if empty or unusable), requires a **reason** from the shared reason list (category `business_time_configuration`; the list shown is `business-time-reasons`, behind the same permission), locks the company row, refuses "already this zone" (so two people making the same change at once make one change), updates, and writes the **decision log** entry `company.timezone_changed` with who, from what, to what, and why. Only after the commit does the process start using the new zone.
- Screen: **Settings, Business Time Zone** (`/admin/settings/business-time`): the zone now, its offset from UTC and what the clock reads there; an **autocomplete** (the shared `ChoicePicker`, never a native select) that loads one page when focused and searches on the server; the reason; an inline confirmation. Nothing can be saved without a different zone and a reason.

## 4. Where the list of zones comes from

The picker's lookup source `business-timezones` asks an **open list of IANA zones** (WorldTimeAPI, `https://worldtimeapi.org/api/timezone`) once a day, in memory, once however many people open the screen (`TimeZoneCatalogue`). Only the request for the list is made: no company, person or order detail is sent. Every name in the answer is checked against the runtime before it is offered; anything that is not a usable zone is dropped. When the service cannot be reached, is slower than four seconds, answers with an error, with something that is not JSON, not a list, a list with no usable zone or far too much, the picker offers the zones the **runtime itself knows** (`Intl.supportedValuesOf`, the same IANA data), retries in five minutes, and keeps an older good answer rather than falling back after a day. Choosing a zone therefore never waits on, or breaks with, an outside service, and saving never depends on the network at all (the service validates against the runtime).

## 5. How the rest of the system follows it

| Where | How |
|---|---|
| Server (business dates, numbering periods, posting dates, report periods, delivery charge rules, quiet hours, slot cut-offs, rider pay, delivery reports, ledger ageing, pricing insights) | `businessTimeZone()` in `kernel/numbering/business-date.ts`: the zone the company chose, which every date calculation reads when it is not told a zone. The process **follows the company row**: whenever the row is read (every request, through `CompanySettingsRepository.ensureSeeded`) or changed here, it tells the kernel; the container reads the row once at start; and the background worker reads it before each job, so a change made by the web process reaches the worker at its next job. A value that is not a usable zone is ignored, so a bad row never breaks every date. Until the row has been read, the built-in zone (`BUILT_IN_TIME_ZONE`) stands in. |
| Shared library formatters (`windowWords`, `stageTime`, `lateText`, `lateAlert`, slot rules) | The zone is a **required parameter**, so nothing can quietly assume a zone. Slot hours are wall-clock hours of the business: `instantInZone` and `dayInZone` work out the instant and the day in any zone, including on the days the clocks change; the old fixed `+03:00` is gone. |
| Screens | The admin, shop and rider layouts read the company row (already read for the request) and give the zone to `BusinessTimeZoneProvider`; screens write a time with `useWhen()` / `useBusinessTimeZone()`. A plain calendar day (`2026-11-06`) has no zone and reads the same everywhere. |

**Deliberately fixed:** the time written to **KRA eTIMS** and the timestamp in the **M-Pesa (Daraja)** password and its replies follow those providers' own Kenya-time rules; they are not the business's choice and do not move with this setting.

## 6. What changing it does, and does not

New documents, postings, text-message quiet hours, delivery windows, report days and every time on screen follow the new zone at once. Documents already made **keep the dates they have**; nothing is rewritten. A slot's hours are wall-clock hours in the business's zone, so changing the zone moves them with it. The screen says this in plain words.

## 7. Verified

Unit: zone shape and validity (places and UTC accepted; abbreviations, offsets, odd shapes and non-text refused), the list from an outside source made safe, offsets and instants in several zones including the days the clocks change, the kernel following the zone and ignoring a bad one, every formatter taking the zone it is given. Catalogue: the open list taken and cleaned, one request however many ask, retried after a day / five minutes, every kind of failure falling back to the runtime's zones. Database: kept on the row, followed at once, logged with who/from/to/why; refused in words for empty, unusable, already this, no reason, an unknown reason; two simultaneous identical changes make one; the database refuses a wrong shape by any door; the actions are refused without `timezone:manage`; the pickers are behind the same permission. Browser (desktop and phone): the zone is chosen from the autocomplete with a reason and a confirmation and a visit booked for 06:00 UTC reads 09:00 before and 15:00 after changing to Tokyo; a manager without the permission sees neither the screen nor the link.

## 8. Not built

A per-branch zone (one company, one zone for now; the country master was always the planned source); showing a customer's own zone beside the business's; converting zone-specific wording in older notes and exports that print a fixed "Nairobi time".
