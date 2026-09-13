# Proof of Donation 💝

Is your website overrun by bots, grifters, rogue agents, and other assorted scum-of-the-earth?

Try replacing your CAPTCHAs with charity donations!

Proof-of-donation is a self-hosted alternative to CAPTCHA. Instead of having your new users solve
a puzzle, have them donate to a supported charity and upload their email receipt. The proof-of-donation
server uses email signatures (DKIM) to verify the authenticity of the receipt ("did the user actually
donate X dollars somewhere?") and return a pass/no-pass.

This project is very new and not currently used anywhere in production. If you'd like to try it
out in the wild, happy to help with setup :)

## How it works

1. You, a website owner, self-host a proof-of-donation server internally.
2. You modify your sign-up page to have the user upload a donation receipt (`.eml` file), instead of
solving a CAPTCHA.
3. Send `POST /verify` to the server from your backend. It will verify the receipt and return pass/no-pass.
4. If they pass, continue with account creation :)

How does it verify a receipt? Most modern email senders cryptographically sign emails sent by them (using a
security standard called DKIM). We can check this signature to verify that the email is in fact from the
given sender and that it has not been tampered with. Once verified, we have a small plugin parse out the
needed info like donation amount from the email, which is typically just a matter of writing an appropriate
regex.

The system can work with any charity that emails a donation receipt (without any direct integration needed from
their end). A plugin system allows extending support to whatever charities you wish to support. All you need is
a small plugin that parses basic info like the donation amount from their receipt emails.

The server itself is meant to be simple to host. It is entirely stateless, with no database or memory of
past requests.

### Demo

Try out the demo. It will give you a sense of the proposed user flow.

```bash
npm install
npm run demo
```

## Quickstart

Run the server with node:

```bash
npm install
cp .env.example .env    # edit as needed
npm run build
node --env-file=.env dist/index.js
```

Run the server in development mode (with auto-reload):

```bash
npm install
npm run dev
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

`:latest` tracks `master` (no versioned releases yet).


## API

### `POST /verify`

Request body: the raw `.eml` message bytes. Query parameters:

| Param         | Required | Description                                                              |
| ------------- | -------- | ------------------------------------------------------------------------- |
| `minAmount`   | yes      | Minimum donation amount required, in the receipt's major currency unit.   |
| `maxAgeHours` | yes      | How recent the donation must be, in hours.                                |
| `currency`    | no       | Required ISO 4217 currency code (e.g. `USD`). If omitted, any currency the plugin reports is accepted. |

No `claimedEmail` param — the server doesn't bind identity for you. It reports `donorEmail`;
compare it yourself. See [Integration Guide](#integration-guide).

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

### `GET /plugins`

What this instance can verify: `{ "plugins": [{ "id", "name", "trustedDkimDomains" }] }`.

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

## Integration Guide

**Host this internally, not publicly.** `/verify` has no built-in auth or rate limiting --
it's meant to be called from your own backend, not exposed directly to the internet or to a
user's browser.

**The server is stateless** — no database, no memory between requests. That means your
website's server is responsible for:

- **Checking `donorEmail`** against an email address you've already validated for the
  account being created. The server has no idea which account this is for, so it can't do
  this check for you.
- **Storing `receiptId`, if you want replay protection** — e.g. to stop a user from reusing
  the same receipt over and over to create many accounts with the same email. If that
  matters to you, save `receiptId` alongside the account you create, and reject any signup
  that reuses one you've already seen.

## Trust model & limitations

Similar to CAPTCHA, proof-of-donation cannot reasonably stop a determined attacker. It can, however,
increase the cost of creating hundreds or thousands of low-effort bot accounts. This can make a substantial
difference for some websites and forums.

- **No refund/chargeback tracking.** A receipt valid at donation time stays valid even if
  later refunded.
- **No currency conversion.** A `CAD` receipt is rejected outright if you require `USD`.
- **DKIM signatures can expire or become unverifiable.** Some platforms set a short explicit
  expiry (as little as ~2 hours); DNS key rotation can also break old signatures. Verify
  soon after donating.
- **Plugins are trusted code.** Only install ones you trust; a malicious plugin has full
  Node.js access.
- **No identity or replay protection here, by design** — see [Integration Guide](#integration-guide).

## Configuration

See `.env.example`. Configured via environment variables (Node's built-in `--env-file` works).

## Requirements

Node.js >= 20.18.1. No database, no native modules to compile.
