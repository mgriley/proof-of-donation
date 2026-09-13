# ProofOfDonation

A CAPTCHA alternative: instead of solving a puzzle, users prove they donated to a real
charity. Self-hosted, verifies a forwarded donation receipt email via DKIM — no charity or
payment processor integration required.

**Not a guarantee.** It raises the cost of creating a fake account; it won't stop a
determined attacker willing to spend real money. See [Trust model & limitations](#trust-model--limitations).

## How it works

1. User uploads their donation receipt (`.eml` file).
2. Server verifies the email's DKIM signature — proves it's genuine and unmodified.
3. A plugin recognizes the sender and extracts the charity, amount, currency, date, and donor email.
4. Server checks that against your requirements (min amount, max age, currency) and returns JSON.

Works with any charity that emails a receipt — no cooperation needed. Stateless: no
database, no memory of past requests (see [Statelessness](#statelessness)).

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

Run the tests (synthetic, offline-signed emails and mock DNS — no real network access or
charity data needed):

```bash
npm test
```

### Docker

```bash
docker run -p 8787:8787 ghcr.io/mgriley/proof-of-donation:latest
```

Or build from source:

```bash
docker build -t proof-of-donation .
docker run -p 8787:8787 proof-of-donation
```

`:latest` tracks `master` (no versioned releases yet). No volume needed — stateless.

### Demo

```bash
npm install
npm run demo
```

Opens a small local page to upload a receipt and see the real verification result — nothing
leaves your machine.

## API

### `POST /verify`

Request body: the raw `.eml` message bytes. Query parameters:

| Param         | Required | Description                                                              |
| ------------- | -------- | ------------------------------------------------------------------------- |
| `minAmount`   | yes      | Minimum donation amount required, in the receipt's major currency unit.   |
| `maxAgeHours` | yes      | How recent the donation must be, in hours.                                |
| `currency`    | no       | Required ISO 4217 currency code (e.g. `USD`). If omitted, any currency the plugin reports is accepted. |

No `claimedEmail` param — the server doesn't bind identity for you. It reports `donorEmail`;
compare it yourself. See [Statelessness](#statelessness).

Always HTTP 200 — check `valid`. Other fields are present whenever a receipt was parsed,
pass or fail:

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
  "reason": "This donation (5 USD) is below the required minimum of 10 USD.",
  "pluginId": "salvation-army",
  "charity": "The Salvation Army",
  "amount": 5,
  "currency": "USD",
  "donatedAt": "2026-09-12T07:00:00.000Z",
  "donorEmail": "donor@example.com",
  "receiptId": "44d1f3ede445ee69333fffd826e8ac646d6f5c9f615ce8aa8945899e054471a2"
}
```

```bash
curl -X POST "http://localhost:8787/verify?minAmount=5&maxAgeHours=48" \
  --data-binary @receipt.eml
```

### `GET /plugins`

What this instance can verify: `{ "plugins": [{ "id", "name", "trustedDkimDomains" }] }`.

### `GET /charities`

Charities to show a donor before they've donated (e.g. a donation picker):
`{ "charities": [{ "charityName", "description", "supportedCurrencies", "donateLink" }] }`.

```bash
curl http://localhost:8787/charities
```

```json
{
  "charities": [
    {
      "charityName": "The Salvation Army",
      "description": "The Salvation Army provides food, shelter, and other social services to people.",
      "supportedCurrencies": ["USD"],
      "donateLink": "https://www.salvationarmyusa.org/ways-to-give/"
    }
  ]
}
```

### `GET /health`

Liveness check: `{ "ok": true }`.

## Supported charities

- **`salvation-army`** — The Salvation Army, via GoFundMe Charity.

More coming — each one needs a real receipt sample to build correctly (see
[Adding a plugin](#adding-a-plugin)).

## Plugin architecture

A plugin declares which DKIM domain(s) it trusts and how to read a receipt from a message
signed by one of them. `parse()` only ever runs on a message that already passed DKIM
verification.

```ts
interface ReceiptPlugin {
  id: string; // unique, stable, e.g. "salvation-army"
  name: string;
  trustedDkimDomains: string[]; // DKIM `d=` domains this plugin will accept
  parse(message: VerifiedMessage): DonationReceipt | null; // null = "not a match", don't throw
}
```

Two ways to get one:

- **RegexPlugin** (default) — a JSON file with a trusted domain/address and a few regexes.
  No code, no npm install. At worst produces a wrong result — it can't execute code, touch
  disk, or make network calls.
- **Code plugin** (`.js`, advanced) — for a template a regex can't express (e.g. amount only
  in a PDF). Runs as trusted code with full Node.js access.

### RegexPlugin schema

```json
{
  "id": "salvation-army",
  "name": "The Salvation Army (via GoFundMe Charity)",
  "charityName": "The Salvation Army",
  "description": "The Salvation Army provides food, shelter, and other social services to people in need.",
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
| `description`         | yes      | What the charity does, shown via `GET /charities`.                          |
| `supportedCurrencies` | yes      | Currencies this charity accepts (display-only — see note below).            |
| `donateLink`          | yes      | `https://` URL where a user can go make a donation.                         |
| `currency`            | yes      | Currency this template's regex extracts (parsing detail — see note below).  |
| `trustedDkimDomains`  | yes      | Array of DKIM `d=` domains this plugin trusts.                               |
| `trustedFromAddress`  | no       | Exact `From:` address required. See below — needed for shared platforms.    |
| `subjectPattern`      | yes      | Regex tested against the subject (case-insensitive). No capture group needed.|
| `amountPattern`       | yes      | Regex with one capture group: the donation amount, e.g. `"12.34"`.           |
| `datePattern`         | yes      | Regex with one capture group: a `Date`-parseable date string.                |

`currency` is a parsing detail (what this template extracts); `supportedCurrencies` is
display metadata (what the charity accepts overall). They can differ.

A plugin file is a JSON array of these objects — one or many per file. A bad entry fails
loudly at startup, naming the file and field.

### Shared donation platforms

Many charities send receipts via a shared platform (GoFundMe Charity, PayPal Giving Fund,
Classy, Stripe), not their own domain — a passing signature only proves *some* campaign on
that platform sent it. Set `trustedFromAddress` to the exact per-charity address to narrow
it down (confirm `From` is in the signature's `h=` list first). Omit it only when the domain
itself is charity-specific. See `plugins/salvation-army.json` for a worked example.

### Adding a plugin

1. Get 1-2 real sample receipts (`.eml`, full headers). Never commit real samples — they
   contain personal data (see `example_receipts/` in `.gitignore`).
2. Check the DKIM `d=` domain and `h=` signed headers to see what you can trust.
3. Write a JSON file matching the schema above in `plugins/`, or a directory listed in
   `PLUGIN_DIRS` (see `.env.example`) — picked up automatically, no code changes.
4. Add a test with fake donor data against the real template's shape (see
   `src/plugins/regex-plugin.test.ts`).

For a template that can't be expressed as regexes, implement `ReceiptPlugin` directly as a
`.js` file instead — `PLUGIN_DIRS` loads both kinds recursively, the same way.

`DISABLE_BUNDLED_PLUGINS=true` skips the bundled `plugins/` directory, for a fully custom
charity list.

## Statelessness

The server keeps no database — it doesn't bind identity or prevent replay itself. `/verify`
returns two fields for you to use instead:

- **`donorEmail`** — the email the receipt was sent to. Compare it against the account being created.
- **`receiptId`** — a stable id for this receipt. Store it alongside the new account, in the
  same database transaction, and reject if already used.

Do both, in your own database — otherwise the same receipt can validate unlimited signups.

## Trust model & limitations

- **Friction, not proof.** DKIM proves a receipt is genuine and from an already-trusted
  charity — not that the donor meant it altruistically. Anyone willing to pay the minimum
  amount can donate through a real, already-supported charity purely to obtain a usable
  receipt; no fake domain or plugin is needed.
- **No refund/chargeback tracking.** A receipt valid at donation time stays valid even if
  later refunded.
- **No currency conversion.** A `CAD` receipt is rejected outright if you require `USD`.
- **DKIM signatures can expire or become unverifiable.** Some platforms set a short explicit
  expiry (as little as ~2 hours); DNS key rotation can also break old signatures. Verify
  soon after donating.
- **Plugins are trusted code.** Only install ones you trust; a malicious plugin has full
  Node.js access.
- **No identity or replay protection here, by design** — see [Statelessness](#statelessness).

## Configuration

See `.env.example`. Configured via environment variables (Node's built-in `--env-file` works).

## Requirements

Node.js >= 20.18.1. No database, no native modules to compile.
