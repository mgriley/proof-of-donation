import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compileRegexPlugin } from './regex-plugin.js';
import type { RegexPluginDescriptor } from './regex-plugin.js';

const VALID: RegexPluginDescriptor = {
  id: 'test-charity',
  name: 'Test Charity',
  charityName: 'Test Charity',
  description: 'A charity that does good things, for testing purposes.',
  supportedCurrencies: ['usd', 'cad'], // deliberately lowercase, to check normalization
  donateLink: 'https://donate.test-charity.example/give',
  currency: 'usd', // deliberately lowercase, to check normalization
  trustedDkimDomains: ['Test-Charity.Example'], // deliberately mixed case
  trustedFromAddress: 'Info@Test-Charity.Example',
  subjectPattern: 'thank you|donation',
  amountPattern: 'amount:\\s*\\$?([\\d.]+)',
  datePattern: 'date:\\s*(.+)'
};

test('compiles a valid descriptor and lowercases domains/addresses/currency', () => {
  const plugin = compileRegexPlugin(VALID);
  assert.equal(plugin.id, 'test-charity');
  assert.deepEqual(plugin.trustedDkimDomains, ['test-charity.example']);
});

test('compiles charityInfo with normalized currencies', () => {
  const plugin = compileRegexPlugin(VALID);
  assert.deepEqual(plugin.charityInfo, {
    charityName: 'Test Charity',
    description: 'A charity that does good things, for testing purposes.',
    supportedCurrencies: ['USD', 'CAD'],
    donateLink: 'https://donate.test-charity.example/give'
  });
});

test('parses a matching message into a DonationReceipt', () => {
  const plugin = compileRegexPlugin(VALID);
  const receipt = plugin.parse({
    subject: 'Thank you for your donation!',
    from: { name: 'Test Charity', address: 'info@test-charity.example' },
    to: [{ name: 'Jane Donor', address: 'jane@example.com' }],
    text: 'Thank you!\nAmount: $42.50\nDate: 2026-09-01',
    dkimDomain: 'test-charity.example'
  });

  assert.ok(receipt);
  assert.equal(receipt?.charityName, 'Test Charity');
  assert.equal(receipt?.amount, 42.5);
  assert.equal(receipt?.currency, 'USD');
  assert.equal(receipt?.donorEmail, 'jane@example.com');
  assert.equal(receipt?.donatedAt.getUTCFullYear(), 2026);
});

test('rejects a message whose From address does not exactly match trustedFromAddress', () => {
  const plugin = compileRegexPlugin(VALID);
  const receipt = plugin.parse({
    subject: 'Thank you for your donation!',
    from: { name: 'Impostor', address: 'info@not-test-charity.example' },
    to: [{ name: '', address: 'jane@example.com' }],
    text: 'Amount: $42.50\nDate: 2026-09-01',
    dkimDomain: 'test-charity.example'
  });
  assert.equal(receipt, null);
});

test('trustedFromAddress is optional -- omitting it accepts any From address on a trusted domain', () => {
  const { trustedFromAddress: _unused, ...descriptorWithoutFrom } = VALID;
  const plugin = compileRegexPlugin(descriptorWithoutFrom);
  const receipt = plugin.parse({
    subject: 'Thank you for your donation!',
    from: { name: 'Anyone', address: 'anyone@test-charity.example' },
    to: [{ name: '', address: 'jane@example.com' }],
    text: 'Amount: $42.50\nDate: 2026-09-01',
    dkimDomain: 'test-charity.example'
  });
  assert.ok(receipt);
});

test('returns null (not a throw) when the amount pattern does not match', () => {
  const plugin = compileRegexPlugin(VALID);
  const receipt = plugin.parse({
    subject: 'Thank you for your donation!',
    from: { name: '', address: 'info@test-charity.example' },
    to: [{ name: '', address: 'jane@example.com' }],
    text: 'No amount here.\nDate: 2026-09-01',
    dkimDomain: 'test-charity.example'
  });
  assert.equal(receipt, null);
});

test('returns null when the date pattern matches but is not a parseable date', () => {
  const plugin = compileRegexPlugin(VALID);
  const receipt = plugin.parse({
    subject: 'Thank you for your donation!',
    from: { name: '', address: 'info@test-charity.example' },
    to: [{ name: '', address: 'jane@example.com' }],
    text: 'Amount: $42.50\nDate: not-a-real-date',
    dkimDomain: 'test-charity.example'
  });
  assert.equal(receipt, null);
});

test('returns null when there is no recipient address', () => {
  const plugin = compileRegexPlugin(VALID);
  const receipt = plugin.parse({
    subject: 'Thank you for your donation!',
    from: { name: '', address: 'info@test-charity.example' },
    to: [],
    text: 'Amount: $42.50\nDate: 2026-09-01',
    dkimDomain: 'test-charity.example'
  });
  assert.equal(receipt, null);
});

for (const [field, value, expectedMessage] of [
  ['id', '', /"id" must be a non-empty string/],
  ['id', 'Not_Valid!', /"id" must be lowercase alphanumeric/],
  ['name', '', /"name" must be a non-empty string/],
  ['charityName', '', /"charityName" must be a non-empty string/],
  ['description', '', /"description" must be a non-empty string/],
  ['donateLink', '', /"donateLink" must be a non-empty string/],
  ['donateLink', 'not a url', /"donateLink" must be a valid URL/],
  ['donateLink', 'http://donate.test-charity.example', /"donateLink" must be an https:\/\/ URL/],
  ['supportedCurrencies', [], /"supportedCurrencies" must be a non-empty array/],
  ['supportedCurrencies', ['US'], /3-letter ISO 4217 code/],
  ['currency', 'US', /3-letter ISO 4217 code/],
  ['currency', '', /"currency" must be a non-empty string/],
  ['trustedDkimDomains', [], /"trustedDkimDomains" must be a non-empty array/],
  ['subjectPattern', '(unclosed', /not a valid regular expression/],
  ['amountPattern', '', /"amountPattern" must be a non-empty string/],
  ['datePattern', '', /"datePattern" must be a non-empty string/]
] as const) {
  test(`rejects an invalid descriptor: ${field} = ${JSON.stringify(value)}`, () => {
    assert.throws(() => compileRegexPlugin({ ...VALID, [field]: value }), expectedMessage);
  });
}

test('the bundled plugins/salvation-army.json file compiles and matches a real-shaped receipt', () => {
  // Mirrors the structure of a real GoFundMe Charity "Thank you for your donation!" receipt
  // for The Salvation Army (verified 2026-09-12), with fake donor details swapped in -- the
  // real sample lives only in the untracked example_receipts/ directory.
  const bundledPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'salvation-army.json');
  const descriptors = JSON.parse(readFileSync(bundledPath, 'utf8')) as RegexPluginDescriptor[];
  assert.equal(descriptors.length, 1);
  const plugin = compileRegexPlugin(descriptors[0]);

  const fixtureBody = `
 Thank you for your donation!

 You have donated $10.70

 to The Salvation Army.

 Donation details
 Donation amount
 $10.00

 Fees covered
 $0.70

 Total
 $10.70

 Donation date
 Sep 12, 2026

 Questions? Contact us at donations@salvationarmyusa.org.
`;

  const receipt = plugin.parse({
    subject: 'Thank you for your donation!',
    from: { name: 'The Salvation Army', address: 'info@the-salvation-army-national-corp.prosend.gofundme.com' },
    to: [{ name: 'Jane Donor', address: 'jane.donor@example.com' }],
    text: fixtureBody,
    dkimDomain: 'prosend.gofundme.com'
  });

  assert.ok(receipt);
  assert.equal(receipt?.charityName, 'The Salvation Army');
  assert.equal(receipt?.amount, 10);
  assert.equal(receipt?.currency, 'USD');
  assert.equal(receipt?.donorEmail, 'jane.donor@example.com');
  assert.equal(receipt?.donatedAt.getUTCFullYear(), 2026);
  assert.equal(receipt?.donatedAt.getUTCMonth(), 8);
  assert.equal(receipt?.donatedAt.getUTCDate(), 12);

  assert.equal(plugin.charityInfo.charityName, 'The Salvation Army');
  assert.ok(plugin.charityInfo.description.length > 0);
  assert.deepEqual(plugin.charityInfo.supportedCurrencies, ['USD']);
  assert.match(plugin.charityInfo.donateLink, /^https:\/\//);

  // And confirms it still rejects an untrusted From address on the same shared platform.
  const impostor = plugin.parse({
    subject: 'Thank you for your donation!',
    from: { name: 'Some Other Charity', address: 'info@some-other-charity.prosend.gofundme.com' },
    to: [{ name: '', address: 'jane.donor@example.com' }],
    text: fixtureBody,
    dkimDomain: 'prosend.gofundme.com'
  });
  assert.equal(impostor, null);
});
