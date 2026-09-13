import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { dkimSign } from 'mailauth';
import type { DNSResolver } from 'mailauth';
import type { ReceiptPlugin } from './plugins/plugin.js';
import { verifyDonation } from './verify.js';

// These tests exercise verifyDonation()'s generic business-rule logic (amount/age/currency
// checks, domain trust) using a throwaway fake plugin and a fake DKIM domain -- deliberately
// decoupled from any real charity/platform so they don't need updating whenever a real
// plugin's regex or trust config changes. See src/plugins/regex-plugin.test.ts for
// template-specific parsing tests.
//
// Note: this server is stateless and does not do identity binding or replay protection --
// it returns donorEmail and receiptId so the integrator can do both against their own
// database. See README "Statelessness".

const SELECTOR = 'test';
const DOMAIN = 'test-charity.example';

const fakePlugin: ReceiptPlugin = {
  id: 'test-charity',
  name: 'Test Charity',
  trustedDkimDomains: [DOMAIN],
  charityInfo: {
    charityName: 'Test Charity',
    description: 'A charity that does good things, for testing purposes.',
    supportedCurrencies: ['USD'],
    donateLink: 'https://donate.test-charity.example/give'
  },
  parse(message) {
    if (!/thank you|donation/i.test(message.subject)) return null;
    const text = message.text ?? '';
    const amountMatch = text.match(/amount:\s*\$?([\d.]+)/i);
    const dateMatch = text.match(/date:\s*(.+)/i);
    if (!amountMatch || !dateMatch) return null;
    const donorEmail = message.to[0]?.address;
    if (!donorEmail) return null;
    return {
      charityName: 'Test Charity',
      amount: Number.parseFloat(amountMatch[1]),
      currency: 'USD',
      donorEmail,
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

test('end-to-end: a valid, freshly-signed receipt passes verifyDonation() and returns donorEmail + receiptId', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(new Date()) }),
    privateKeyPem
  );

  const result = await verifyDonation({ emlBuffer: signed, minAmount: 10, maxAgeHours: 24 }, [fakePlugin], {
    resolver: mockResolver(publicKeyDer)
  });

  assert.equal(result.valid, true);
  assert.equal(result.charity, 'Test Charity');
  assert.equal(result.amount, 25);
  assert.equal(result.currency, 'USD');
  assert.equal(result.donorEmail, 'donor@example.com');
  assert.ok(result.receiptId && /^[0-9a-f]{64}$/.test(result.receiptId));
});

test('verifying the same receipt twice returns the same receiptId and does not fail (server is stateless)', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(new Date()) }),
    privateKeyPem
  );
  const overrides = { resolver: mockResolver(publicKeyDer) };

  const first = await verifyDonation({ emlBuffer: signed, minAmount: 10, maxAgeHours: 24 }, [fakePlugin], overrides);
  const second = await verifyDonation({ emlBuffer: signed, minAmount: 10, maxAgeHours: 24 }, [fakePlugin], overrides);

  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  assert.equal(first.receiptId, second.receiptId);
});

test('end-to-end: fails when the donation amount is below the requested minimum, but still returns the parsed fields', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '5.00', dateText: isoDate(new Date()) }),
    privateKeyPem
  );

  const result = await verifyDonation({ emlBuffer: signed, minAmount: 10, maxAgeHours: 24 }, [fakePlugin], {
    resolver: mockResolver(publicKeyDer)
  });

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /below the required minimum/);
  // Even on failure, the extracted facts are returned -- the integrator may still find
  // donorEmail/amount useful for diagnostics or logging.
  assert.equal(result.amount, 5);
  assert.equal(result.donorEmail, 'donor@example.com');
});

test('end-to-end: fails a stale receipt older than maxAgeHours', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(oldDate) }),
    privateKeyPem
  );

  const result = await verifyDonation({ emlBuffer: signed, minAmount: 10, maxAgeHours: 24 }, [fakePlugin], {
    resolver: mockResolver(publicKeyDer)
  });

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /older than the allowed/);
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

  const result = await verifyDonation({ emlBuffer: signed, minAmount: 10, maxAgeHours: 24 }, [fakePlugin], {
    resolver: mockResolver(publicKeyDer, untrustedDomain)
  });

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /isn't supported by this server/);
});

test('end-to-end: fails when the message has no DKIM signature at all', async () => {
  // A plain, never-signed email -- same content that would otherwise pass every other check.
  const raw = Buffer.from(buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(new Date()) }));

  // No resolver override needed: with no DKIM-Signature header present, dkimVerify never
  // performs a DNS lookup at all.
  const result = await verifyDonation({ emlBuffer: raw, minAmount: 10, maxAgeHours: 24 }, [fakePlugin]);

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /authenticity could not be verified/);
});

test('end-to-end: fails when the message body was altered after signing (DKIM signature mismatch)', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(new Date()) }),
    privateKeyPem
  );
  // Tamper with the body after signing, without re-signing -- the DKIM body hash (bh=) can
  // no longer match, so a correctly-formed signature over the wrong content must still fail.
  const tampered = Buffer.from(signed.toString('utf8').replace('Amount: $25.00', 'Amount: $999.00'));
  assert.notEqual(tampered.toString('utf8'), signed.toString('utf8'));

  const result = await verifyDonation({ emlBuffer: tampered, minAmount: 10, maxAgeHours: 24 }, [fakePlugin], {
    resolver: mockResolver(publicKeyDer)
  });

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /authenticity could not be verified/);
});

test('end-to-end: fails when the DKIM public key on DNS does not match the signature', async () => {
  const { privateKeyPem } = generateKeyPair();
  const { publicKeyDer: wrongPublicKeyDer } = generateKeyPair(); // a different, unrelated keypair
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(new Date()) }),
    privateKeyPem
  );

  const result = await verifyDonation({ emlBuffer: signed, minAmount: 10, maxAgeHours: 24 }, [fakePlugin], {
    resolver: mockResolver(wrongPublicKeyDer)
  });

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /authenticity could not be verified/);
});

test('end-to-end: fails gracefully (does not throw) on input that is not an email at all', async () => {
  const raw = Buffer.from('this is not an email at all, just some random bytes');

  const result = await verifyDonation({ emlBuffer: raw, minAmount: 10, maxAgeHours: 24 }, [fakePlugin]);

  assert.equal(result.valid, false);
  assert.equal(typeof result.reason, 'string');
});

test('end-to-end: fails when receipt currency does not match the required currency', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(new Date()) }),
    privateKeyPem
  );

  const result = await verifyDonation(
    { emlBuffer: signed, minAmount: 10, maxAgeHours: 24, currency: 'CAD' },
    [fakePlugin],
    { resolver: mockResolver(publicKeyDer) }
  );

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /is required/);
});

test('end-to-end: fails when the donation timestamp is in the future', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const signed = await signEmail(
    buildRawEmail({ to: 'donor@example.com', amount: '25.00', dateText: isoDate(futureDate) }),
    privateKeyPem
  );

  const result = await verifyDonation({ emlBuffer: signed, minAmount: 10, maxAgeHours: 24 }, [fakePlugin], {
    resolver: mockResolver(publicKeyDer)
  });

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /future/);
});

test('end-to-end: fails when a trusted domain signs a message that matches no plugin template', async () => {
  const { publicKeyDer, privateKeyPem } = generateKeyPair();
  const raw = [
    `From: Test Charity <noreply@${DOMAIN}>`,
    'To: donor@example.com',
    'Subject: Your password was reset',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${DOMAIN}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your account password was successfully reset.',
    ''
  ].join('\r\n');
  const signed = await signEmail(raw, privateKeyPem);

  const result = await verifyDonation({ emlBuffer: signed, minAmount: 10, maxAgeHours: 24 }, [fakePlugin], {
    resolver: mockResolver(publicKeyDer)
  });

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /doesn't match a known donation receipt format/);
});

test('rejects when no plugins are enabled on the server', async () => {
  const result = await verifyDonation({ emlBuffer: Buffer.from('irrelevant'), minAmount: 10, maxAgeHours: 24 }, []);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /no supported charities configured/);
});

test('rejects requests with an invalid minAmount or maxAgeHours before doing any DKIM work', async () => {
  const negativeAmount = await verifyDonation({ emlBuffer: Buffer.from(''), minAmount: -1, maxAgeHours: 24 }, [fakePlugin]);
  assert.equal(negativeAmount.valid, false);
  assert.match(negativeAmount.reason ?? '', /minAmount must be zero or greater/);

  const zeroAge = await verifyDonation({ emlBuffer: Buffer.from(''), minAmount: 10, maxAgeHours: 0 }, [fakePlugin]);
  assert.equal(zeroAge.valid, false);
  assert.match(zeroAge.reason ?? '', /maxAgeHours must be greater than zero/);
});
