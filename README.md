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
   amount, maximum age, matching email, currency) and against a local replay-protection
   database (so one receipt can't validate more than one signup).
6. The server returns a simple `{ valid, reason?, charity?, amount?, ... }` JSON response.
   It never returns the raw email content back to the caller.

No cooperation from the charity or donation platform is required -- this works with any
donation receipt sent to a normal inbox, which is what makes it buildable and self-hostable
by anyone.

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
docker run -p 8787:8787 -v proof-of-donation-data:/data proof-of-donation
```

## API

### `POST /verify`

Request body: the raw `.eml` message bytes (any `Content-Type` is accepted as opaque
bytes). Query parameters:

| Param          | Required | Description                                                              |
| -------------- | -------- | ------------------------------------------------------------------------- |
| `claimedEmail` | yes      | The email address the caller is trying to prove donated. Must match the receipt's `To:` address. |
| `minAmount`    | yes      | Minimum donation amount required, in the receipt's major currency unit.   |
| `maxAgeHours`  | yes      | How recent the donation must be, in hours. Capped by the server's `MAX_AGE_HOURS_CEILING`. |
| `currency`     | no       | Required ISO 4217 currency code (e.g. `USD`). If omitted, any currency the plugin reports is accepted. |
| `plugin`       | no       | Restrict matching to one specific installed plugin id.                    |

Response (always HTTP 200 for a well-formed request, even when the donation doesn't
qualify -- check the `valid` field):

```json
{ "valid": true, "pluginId": "salvation-army", "charity": "The Salvation Army", "amount": 10, "currency": "USD", "donatedAt": "2026-09-12T07:00:00.000Z" }
```

```json
{ "valid": false, "reason": "donation amount 5 USD is below the required minimum of 10" }
```

Example:

```bash
curl -X POST "http://localhost:8787/verify?claimedEmail=you@example.com&minAmount=5&maxAgeHours=48" \
  --data-binary @receipt.eml
```

### `GET /plugins`

Lists the plugins enabled on this instance, so an integrator can see what it can verify
before wiring anything up: `{ "plugins": [{ "id", "name", "trustedDkimDomains" }] }`.

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

A plugin is any object implementing:

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

### A subtlety: shared donation platforms

Many charities (Salvation Army included) don't send receipts from their own domain -- they
use a shared platform like GoFundMe Charity, PayPal Giving Fund, Classy, or Stripe. A
passing DKIM signature from `prosend.gofundme.com` only proves "some charity/campaign on
GoFundMe Charity sent this," not which one. For these, the plugin must additionally check a
field that's both charity-specific and covered by the DKIM signature -- typically the exact
`From:` address, which platforms assign per-charity account and which can't be forged
without invalidating the signature (verify the header is actually in the signature's `h=`
list before relying on this). See `src/plugins/builtin/salvation-army.ts` for a worked
example, including the comment on how that address was confirmed to be signed.

### Adding a plugin

1. Get 1-2 real sample receipts (`.eml`, with full headers -- "show original" in Gmail, or
   equivalent). Never commit real samples to source control; they contain personal data
   (see `example_receipts/` in `.gitignore`).
2. Confirm the DKIM signing domain (`d=` tag) and which headers are signed (`h=` tag) --
   this tells you whether you can trust `From`, `Subject`, etc.
3. Write a small module implementing `ReceiptPlugin` (`src/plugins/builtin/util.ts` has
   `bodyText()`, `stripHtml()`, `parseAmount()`, `firstEmailAddress()` helpers).
4. Add it to `src/plugins/builtin/index.ts`, or ship it as a standalone module and point
   `EXTERNAL_PLUGINS` at it (comma-separated paths/specifiers; see `.env.example`) --
   external plugins run as trusted code with full Node.js access, same as any dependency.
5. Write a unit test against the real template's structure with fake donor data swapped in
   (see `src/plugins/builtin/salvation-army.test.ts`).

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
- **Multiple installed instances don't share replay state.** Replay protection is a local
  SQLite database per instance. If you run more than one instance behind a load balancer,
  point them at the same database file/volume, or a receipt could be used once per instance.

## Configuration

See `.env.example`. All configuration is via environment variables (loadable with Node's
built-in `--env-file` flag, no extra dependency needed).

## Requirements

Node.js >= 22.5 (uses the built-in `node:sqlite` module -- currently experimental upstream,
which is why you'll see an `ExperimentalWarning` on startup; this avoids depending on a
native compiled module like `better-sqlite3`, which is one less thing that can fail to
build when someone self-hosts this).
