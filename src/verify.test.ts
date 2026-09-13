import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { dkimSign } from 'mailauth';
import type { DNSResolver } from 'mailauth';
import type { ReceiptPlugin } from './types.js';
import { verifyDonation } from './verify.js';
import { ReceiptStore } from './db.js';

// These tests exercise verifyDonation()'s generic business-rule logic (replay protection,
// amount/age/identity checks, domain trust) using a throwaway fake plugin and a fake DKIM
// domain -- deliberately decoupled from any real charity/platform so they don't need
// updating whenever a real plugin's regex or trust config changes. See
// src/plugins/builtin/salvation-army.test.ts for template-specific parsing tests.

const SELECTOR = 'test';
const DOMAIN = 'test-charity.example';

const fakePlugin: ReceiptPlugin = {
  id: 'test-charity',
  name: 'Test Charity',
  trustedDkimDomains: [DOMAIN],
  parse(message) {
    if (!/thank you|donation/i.test(message.subject)) return null;
    const text = message.text ?? '';
    const amountMatch = text.match(/amount:\s*\$?([\d.]+)/i);
    const dateMatch = text.match(/date:\s*(.+)/i);
    if (!amountMatch || !dateMatch) return null;
    const emailMatch = message.to.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    if (!emailMatch) return null;
    return {
      charityName: 'Test Charity',
      amount: Number.parseFloat(amountMatch[1]),
      currency: 'USD',
      donorEmail: emailMatch[0],
      donatedAt: new Date(dateMatch[1])
    };
  }
};

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { publicKeyDer, privateKeyPem };
}

function mockResolver(publicKeyDer: string, domain = DOMAIN): DNSResolver {
  return async (queryDomain: string, rrtype: string) => {
    if (rrtype === 'TXT' && queryDomain === `${SELECTOR}._domainkey.${domain}`) {
      return [[`v=DKIM1; k=rsa; p=${publicKeyDer}`]];
    }
    return [];
  };
}

function buildRawEmail(opts: { to: string; amount: string; dateText: string; domain?: string }): string {
  const domain = opts.domain ?? DOMAIN;
  const lines = [
    `From: Test Charity <noreply@${domain}>`,
    `To: ${opts.to}`,
    `Subject: Thank you for your donation!`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Thank you for your generous gift.',
    `Amount: $${opts.amount}`,
    `Date: ${opts.dateText}`,
    ''
  ];
  return lines.join('\r\n');
}

async function signEmail(raw: string, privateKeyPem: string, domain = DOMAIN): Promise<Buffer> {
  // Note: mailauth's shipped .d.ts advertises signingDomain/selector/privateKey as
  // top-level dkimSign() options, but the actual implementation (confirmed against its
  // README and lib/commands/sign.js) only honors them nested under `signatureData`.
  const { signatures } = await dkimSign(Buffer.from(raw), {
    signatureData: [{ signingDomain: domain, selector: SELECTOR, privateKey: privateKeyPem }]
  } as Parameters<typeof dkimSign>[1]);
  return Buffer.from(signatures + raw);
}

function isoDate(d: Date): string {
  return d.toISOString();
}

test('end-to-end: a valid, freshly-signed receipt passes verifyDonation()', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(new Date()) }),
    privateKeyPem
  );
  const store = new ReceiptStore(':memory:');

  const result = await verifyDonation(
    { emlBuffer: signed, claimedEmail: 'donor@example.com', minAmount: 10, maxAgeHours: 24 },
    [fakePlugin],
    store,
    720,
    { resolver: mockResolver(publicKeyDer) }
  );

  assert.equal(result.valid, true);
  assert.equal(result.charity, 'Test Charity');
  assert.equal(result.amount, 25);
  assert.equal(result.currency, 'USD');
  store.close();
});

test('end-to-end: the same receipt cannot be used twice (replay protection)', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(new Date()) }),
    privateKeyPem
  );
  const store = new ReceiptStore(':memory:');
  const req = { emlBuffer: signed, claimedEmail: 'donor@example.com', minAmount: 10, maxAgeHours: 24 };
  const overrides = { resolver: mockResolver(publicKeyDer) };

  const first = await verifyDonation(req, [fakePlugin], store, 720, overrides);
  const second = await verifyDonation(req, [fakePlugin], store, 720, overrides);

  assert.equal(first.valid, true);
  assert.equal(second.valid, false);
  assert.match(second.reason ?? '', /already been used/);
  store.close();
});

test('end-to-end: fails when the donation amount is below the requested minimum', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '5.00', dateText: isoDate(new Date()) }),
    privateKeyPem
  );
  const store = new ReceiptStore(':memory:');

  const result = await verifyDonation(
    { emlBuffer: signed, claimedEmail: 'donor@example.com', minAmount: 10, maxAgeHours: 24 },
    [fakePlugin],
    store,
    720,
    { resolver: mockResolver(publicKeyDer) }
  );

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /below the required minimum/);
  store.close();
});

test('end-to-end: fails when the claimed email does not match the receipt recipient', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(new Date()) }),
    privateKeyPem
  );
  const store = new ReceiptStore(':memory:');

  const result = await verifyDonation(
    { emlBuffer: signed, claimedEmail: 'someone-else@example.com', minAmount: 10, maxAgeHours: 24 },
    [fakePlugin],
    store,
    720,
    { resolver: mockResolver(publicKeyDer) }
  );

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /donor email does not match/);
  store.close();
});

test('end-to-end: fails a stale receipt older than maxAgeHours', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(oldDate) }),
    privateKeyPem
  );
  const store = new ReceiptStore(':memory:');

  const result = await verifyDonation(
    { emlBuffer: signed, claimedEmail: 'donor@example.com', minAmount: 10, maxAgeHours: 24 },
    [fakePlugin],
    store,
    720,
    { resolver: mockResolver(publicKeyDer) }
  );

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /older than the allowed/);
  store.close();
});

test('end-to-end: a DKIM signature from an untrusted domain is rejected even with a perfect body', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const untrustedDomain = 'not-an-enabled-plugin.example';
  const raw = buildRawEmail({
    to: 'donor@example.com',
    amount: '25.00',
    dateText: isoDate(new Date()),
    domain: untrustedDomain
  });
  const signed = await signEmail(raw, privateKeyPem, untrustedDomain);
  const store = new ReceiptStore(':memory:');

  const result = await verifyDonation(
    { emlBuffer: signed, claimedEmail: 'donor@example.com', minAmount: 10, maxAgeHours: 24 },
    [fakePlugin],
    store,
    720,
    { resolver: mockResolver(publicKeyDer, untrustedDomain) }
  );

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /not trusted/);
  store.close();
});

test('ReceiptStore.claim() allows first use and blocks repeats', () => {
  const store = new ReceiptStore(':memory:');
  assert.equal(store.claim('id-1', 'test-charity', 'donor@example.com'), true);
  assert.equal(store.claim('id-1', 'test-charity', 'donor@example.com'), false);
  assert.equal(store.claim('id-2', 'test-charity', 'donor@example.com'), true);
  store.close();
});
