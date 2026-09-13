# ProofOfDonation

A small, self-hostable server that verifies charity donation receipt emails so a website
(e.g. a forum signup form) can require "prove you donated at least $X to an approved
charity in the last Y hours" as a bot/spam friction layer -- without a human reviewer.

**What this is not:** a cryptographic guarantee of donor intent. It raises the cost of
creating a fake account; it does not prevent a determined attacker who is willing to spend
real money and effort. See [Trust model & known limitations](#trust-model--known-limitations).

## How it works

1. A user uploads the raw `.eml` source of a donation receipt email (most mail clients have
   a "show original" / "download message" option).
2. The server verifies the email's **DKIM signature** -- this cryptographically proves the
   message (headers and body, byte for byte) was sent unmodified by whichever mail server
   holds the private key for the signing domain. It does not, by itself, prove the message
   is a real receipt or says anything in particular.
3. The DKIM signing domain is looked up against a table of installed **plugins**, each of
   which declares which domain(s) it trusts and knows how to parse a specific charity's (or
   donation platform's) receipt template.
4. The matching plugin extracts the donation amount, currency, date, and donor email from
   the verified message.
5. The server checks the extracted donation against the caller's requirements (minimum
   amount, maximum age, currency).
6. The server returns a simple `{ valid, reason?, charity?, amount?, donorEmail?, receiptId?, ... }`
   JSON response. It never returns the raw email content back to the caller.

No cooperation from the charity or donation platform is required -- this works with any
donation receipt sent to a normal inbox, which is what makes it buildable and self-hostable
by anyone.

This server is **stateless** -- it keeps no database and no memory of past requests. It
answers "does this receipt satisfy these requirements, and who was it sent to," and nothing
more. See [Statelessness & the integrator's responsibilities](#statelessness--the-integrators-responsibilities)
for what that means for you as an integrator.

## Quickstart

```bash
npm install
cp .env.example .env    # edit as needed
npm run build
node --env-file=.env dist/index.js
```

Or for local development (auto-restart, runs TypeScript directly):

```bash
npm install
npm run dev
```

Run the test suite (uses synthetic, offline-signed test emails and mock DNS -- no real
network access or real charity data required):

```bash
npm test
```

### Docker

```bash
docker build -t proof-of-donation .
docker run -p 8787:8787 proof-of-donation
```

No volume needed -- the server keeps no state of its own.

### Try it locally (demo)

```bash
npm install
npm run demo
```

Then open the printed URL. It's a tiny page (plain Vue, no build step) for uploading a real
`.eml` receipt and seeing the raw `/verify`-shaped JSON result -- useful for seeing what this
actually does before wiring up an integration. It runs the same verification logic
in-process; nothing you upload is sent anywhere else (see `demo/server.ts`).

## API

### `POST /verify`

Request body: the raw `.eml` message bytes (any `Content-Type` is accepted as opaque
bytes). Query parameters:

| Param         | Required | Description                                                              |
| ------------- | -------- | ------------------------------------------------------------------------- |
| `minAmount`   | yes      | Minimum donation amount required, in the receipt's major currency unit.   |
| `maxAgeHours` | yes      | How recent the donation must be, in hours.                                |
| `currency`    | no       | Required ISO 4217 currency code (e.g. `USD`). If omitted, any currency the plugin reports is accepted. |

Note there's no `claimedEmail` param -- this server doesn't do identity binding for you.
It reports whichever email the receipt was actually sent to (`donorEmail`); you compare
that against your own already-verified account email. See
[Statelessness & the integrator's responsibilities](#statelessness--the-integrators-responsibilities).

Response (always HTTP 200 for a well-formed request, even when the donation doesn't
qualify -- check the `valid` field). Fields other than `valid`/`reason` are present
whenever a receipt was successfully parsed, whether or not it met your requirements:

```json
{
  "valid": true,
  "pluginId": "salvation-army",
  "charity": "The Salvation Army",
  "amount": 10,
  "currency": "USD",
  "donatedAt": "2026-09-12T07:00:00.000Z",
  "donorEmail": "donor@example.com",
  "receiptId": "44d1f3ede445ee69333fffd826e8ac646d6f5c9f615ce8aa8945899e054471a2"
}
```

```json
{
  "valid": false,
  "reason": "donation amount 5 USD is below the required minimum of 10",
  "pluginId": "salvation-army",
  "charity": "The Salvation Army",
  "amount": 5,
  "currency": "USD",
  "donatedAt": "2026-09-12T07:00:00.000Z",
  "donorEmail": "donor@example.com",
  "receiptId": "44d1f3ede445ee69333fffd826e8ac646d6f5c9f615ce8aa8945899e054471a2"
}
```

Example:

```bash
curl -X POST "http://localhost:8787/verify?minAmount=5&maxAgeHours=48" \
  --data-binary @receipt.eml
```

### `GET /plugins`

Lists the plugins enabled on this instance, so an integrator can see what it can verify
before wiring anything up: `{ "plugins": [{ "id", "name", "trustedDkimDomains" }] }`.

### `GET /charities`

For showing an end user "here's who you can donate to" *before* they've made a donation --
e.g. a donation picker on a signup page. Returns each supported charity's static display
info: `{ "charities": [{ "charityName", "description", "supportedCurrencies", "donateLink" }] }`.

```bash
curl http://localhost:8787/charities
```

```json
{
  "charities": [
    {
      "charityName": "The Salvation Army",
      "description": "The Salvation Army provides food, shelter, disaster relief, and other social services to people in need across local communities.",
      "supportedCurrencies": ["USD"],
      "donateLink": "https://www.salvationarmyusa.org/ways-to-give/"
    }
  ]
}
```

### `GET /health`

Liveness check: `{ "ok": true }`.

## Supported charities / plugins

- **`salvation-army`** -- The Salvation Army, via GoFundMe Charity's donation platform.

That's it for now -- adding more is the natural next step (see below). Each one takes real
receipt samples to build correctly; guessing at an unverified template is worse than not
having the plugin at all.

## Plugin architecture

Trust in this system is **not** "does the DKIM signature pass" alone -- plenty of domains
can produce a passing signature for content that has nothing to do with a real donation.
Trust is "does a passing signature, from a domain an operator has explicitly configured,
parse into a receipt matching a specific charity's real template." Each plugin owns that
second half.

Every plugin implements the same small interface:

```ts
interface ReceiptPlugin {
  id: string; // unique, stable, e.g. "salvation-army"
  name: string;
  trustedDkimDomains: string[]; // DKIM `d=` domains this plugin will accept
  parse(message: VerifiedMessage): DonationReceipt | null; // null = "not a match", don't throw
}
```

`parse()` is only ever called on a message whose DKIM signature already verified against one
of `trustedDkimDomains` -- plugins never see unverified content.

You never write this interface by hand, though. There are two ways to get one:

- **A RegexPlugin** (`src/plugins/regex-plugin.ts`) -- a plain JSON file describing a
  trusted domain/address and a few regexes. This is the default, recommended path: no code,
  no npm install, no trusting arbitrary logic. A malformed or even maliciously-written
  RegexPlugin file can at worst produce a wrong verification result -- it cannot execute
  code, touch the filesystem, or make network calls, because it isn't code. Adding a charity
  means writing a JSON file, not writing a plugin.
- **A hand-written `ReceiptPlugin`** in a `.js` file -- the advanced escape hatch for a
  template a RegexPlugin genuinely can't express (e.g. the amount only appears in a PDF
  attachment, not the body). This runs as trusted code with full Node.js access, the same
  as any other server-side dependency -- only point this at code you trust.

### RegexPlugin schema

```json
{
  "id": "salvation-army",
  "name": "The Salvation Army (via GoFundMe Charity)",
  "charityName": "The Salvation Army",
  "description": "The Salvation Army provides food, shelter, disaster relief, and other social services to people in need across local communities.",
  "supportedCurrencies": ["USD"],
  "donateLink": "https://www.salvationarmyusa.org/ways-to-give/",
  "currency": "USD",
  "trustedDkimDomains": ["prosend.gofundme.com"],
  "trustedFromAddress": "info@the-salvation-army-national-corp.prosend.gofundme.com",
  "subjectPattern": "thank you|donation|receipt",
  "amountPattern": "donation amount\\s*\\$?\\s*([\\d,]+\\.\\d{2})",
  "datePattern": "donation date\\s*([A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4})"
}
```

| Field                 | Required | Description                                                                 |
| --------------------- | -------- | ---------------------------------------------------------------------------- |
| `id`                  | yes      | Unique, stable, lowercase-with-hyphens.                                      |
| `name`                | yes      | Human-readable name for logs/docs.                                           |
| `charityName`         | yes      | Reported in a successful result, and shown via `GET /charities`.            |
| `description`         | yes      | Brief, plain-language description of what the charity does. Shown via `GET /charities`. |
| `supportedCurrencies` | yes      | Array of ISO 4217 codes this charity's donation page accepts. Display-only -- see below. |
| `donateLink`          | yes      | `https://` URL where a user can go make a donation. Shown via `GET /charities`. |
| `currency`            | yes      | ISO 4217 code this template's `amountPattern` is written to extract, e.g. `"USD"`. A parsing detail, not the same thing as `supportedCurrencies`. |
| `trustedDkimDomains`  | yes      | Array of DKIM `d=` domains this plugin trusts.                               |
| `trustedFromAddress`  | no       | Exact `From:` address required. See below -- needed for shared platforms.    |
| `subjectPattern`      | yes      | Regex tested against the subject (case-insensitive). No capture group needed.|
| `amountPattern`       | yes      | Regex with one capture group: the donation amount, e.g. `"12.34"`.           |
| `datePattern`         | yes      | Regex with one capture group: a `Date`-parseable date string.                |

`currency` and `supportedCurrencies` are deliberately separate: `currency` is what this
specific regex template is written to extract from a receipt's body (a parsing detail,
always exactly one), while `supportedCurrencies` is informational metadata about what the
charity's donation page accepts overall (for a donation-picker UI) -- they may not always
match, e.g. if a charity accepts multiple currencies but this particular receipt template
only ever reports one of them.

A plugin **file** is a JSON array of these objects -- one file can hold any number of
plugins, including a single one. A bad entry (invalid regex, missing field, malformed id)
fails loudly at startup with the file path and field name, rather than silently matching
nothing or, worse, matching too much.

### A subtlety: shared donation platforms

Many charities (Salvation Army included) don't send receipts from their own domain -- they
use a shared platform like GoFundMe Charity, PayPal Giving Fund, Classy, or Stripe. A
passing DKIM signature from `prosend.gofundme.com` only proves "some charity/campaign on
GoFundMe Charity sent this," not which one. For these, set `trustedFromAddress` to the exact
address the platform assigns per-charity account -- that address can't be forged without
invalidating the signature (confirm `From` is actually in the signature's `h=` list before
relying on this). Omit `trustedFromAddress` only when the domain itself is charity-specific
and sufficient on its own. See `plugins/salvation-army.json` for a worked example.

### Adding a plugin

1. Get 1-2 real sample receipts (`.eml`, with full headers -- "show original" in Gmail, or
   equivalent). Never commit real samples to source control; they contain personal data
   (see `example_receipts/` in `.gitignore`).
2. Confirm the DKIM signing domain (`d=` tag) and which headers are signed (`h=` tag) --
   this tells you whether you can trust `From`, `Subject`, etc.
3. Write a JSON file matching the schema above and drop it in `plugins/` (bundled with the
   server), or in a directory you list in `PLUGIN_DIRS` (comma-separated paths; see
   `.env.example`) -- either way it's picked up automatically at startup, no code changes
   needed.
4. Write a unit test against the real template's structure with fake donor data swapped in
   (see `src/plugins/regex-plugin.test.ts`'s bundled-file test for the pattern to follow).

If the template genuinely can't be expressed as regexes against the subject/body (rare --
e.g. the amount is only in a PDF attachment), implement `ReceiptPlugin` directly instead as
a `.js` file in a `PLUGIN_DIRS` directory. Every directory listed in `PLUGIN_DIRS` (plus the
bundled `plugins/` directory, always included) is scanned the same way: `.json` files load
as RegexPlugins, `.js` files load as code-based plugins (default, or named `plugin`, export).

## Statelessness & the integrator's responsibilities

This server verifies and extracts facts from a receipt; it does not decide who those facts
belong to or whether they've been used before. That's deliberate, not an oversight -- an
earlier design had this server enforce identity matching and replay protection itself, and
it had a real bug: if the integrator's own signup write failed *after* a successful
`/verify` call (a crashed request, a bug, a timeout), the donor's receipt was already marked
"used" here, permanently, with no way to retry -- through no fault of their own.

Instead, `/verify` returns two things for the integrator to act on:

- **`donorEmail`** -- the email address the receipt was actually sent to. Compare it
  (case-insensitively) against the email address on the account already being created --
  this is the identity check, and it belongs on your side because you're the one who knows
  which account it needs to match.
- **`receiptId`** -- a stable id derived from the receipt's DKIM signature. Store it
  alongside the new account, **in the same database write/transaction** that creates the
  account, and check for it before creating one. That's what actually prevents one receipt
  from validating more than one signup: the check and the effect it's protecting happen
  atomically, in your database, instead of being two separate steps across a network call
  that can fail independently.

This also means: if you don't store `receiptId` yourself, there is no replay protection at
all, and the same receipt can validate unlimited signups. That's the real cost of statelessness
here -- it's not a default you get for free anymore, it's a step you have to actually do.

## Trust model & known limitations

- **This is a friction layer, not a guarantee.** DKIM proves an email is unmodified and
  came from the claimed domain; it says nothing about donor intent. Someone willing to spend
  real money and effort could donate a small amount to themselves through a real charity
  channel to farm a valid receipt. Combine this with other signals (rate limiting, review)
  for anything higher-stakes than raising bot cost.
- **Refunds/chargebacks aren't tracked.** A receipt that was valid at donation time stays
  valid even if the donor is refunded minutes later. Out of scope for tonight.
- **No currency conversion.** If you require `USD` and a receipt is in `CAD`, it's rejected
  outright rather than converted.
- **DKIM key rotation** could in principle make an old, previously-valid signature fail
  verification later. In practice this only matters for receipts far outside a normal
  freshness window (`maxAgeHours`), since keys don't rotate on the timescale of hours.
- **Plugins are trusted code.** Only enable/install plugins you trust; a malicious plugin
  has full Node.js access, same as any other server-side dependency.
- **No identity binding or replay protection happens here.** By design -- see
  [Statelessness & the integrator's responsibilities](#statelessness--the-integrators-responsibilities).
  If you don't implement both on your side, the same receipt can create unlimited accounts.

## Configuration

See `.env.example`. All configuration is via environment variables (loadable with Node's
built-in `--env-file` flag, no extra dependency needed).

## Requirements

Node.js >= 20.18.1 (the floor set by the `mailauth` dependency). No database, no native
modules to compile -- the server itself has no storage requirements at all.
