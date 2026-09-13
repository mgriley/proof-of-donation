import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salvationArmyPlugin } from './salvation-army.js';

// Fixture text mirrors the structure of a real GoFundMe Charity "Thank you for your
// donation!" receipt for The Salvation Army (verified 2026-09-12), with fake donor details
// swapped in -- the real sample lives only in the untracked example_receipts/ directory
// since it contains real personal donation data.
const TRUSTED_FROM = 'The Salvation Army <info@the-salvation-army-national-corp.prosend.gofundme.com>';

function fixtureBody(opts: { amount?: string; total?: string; dateText?: string }): string {
  return `
 Thank you for your donation!

 Thank you for your donation. You've brought joy to people in need right in your community.

 You have donated $${opts.total ?? '10.70'}

 to The Salvation Army.

 Donation details
 Donation amount
 $${opts.amount ?? '10.00'}

 Fees covered
 $0.70

 Total
 $${opts.total ?? '10.70'}

 Donation number
 193978949

 Donation date
 ${opts.dateText ?? 'Sep 12, 2026'}

 Designation
 Mountain View, CA 94041

 Questions? Contact us at donations@salvationarmyusa.org or visit the help center for more info.
`;
}

test('parses amount, currency, date, and donor email from a real-shaped receipt', () => {
  const receipt = salvationArmyPlugin.parse({
    subject: 'Thank you for your donation!',
    from: TRUSTED_FROM,
    to: 'Jane Donor <jane.donor@example.com>',
    text: fixtureBody({}),
    dkimDomain: 'prosend.gofundme.com'
  });

  assert.ok(receipt);
  assert.equal(receipt?.charityName, 'The Salvation Army');
  // Uses "Donation amount" ($10.00), not "Total" ($10.70) -- the total can include an
  // optional donor-paid fee-cover that goes to the platform, not the charity.
  assert.equal(receipt?.amount, 10);
  assert.equal(receipt?.currency, 'USD');
  assert.equal(receipt?.donorEmail, 'jane.donor@example.com');
  assert.equal(receipt?.donatedAt.getUTCFullYear(), 2026);
  assert.equal(receipt?.donatedAt.getUTCMonth(), 8); // September, 0-indexed
  assert.equal(receipt?.donatedAt.getUTCDate(), 12);
});

test('rejects a message whose From address is not the trusted Salvation Army account, even on the same platform', () => {
  const receipt = salvationArmyPlugin.parse({
    subject: 'Thank you for your donation!',
    from: 'Some Other Charity <info@some-other-charity.prosend.gofundme.com>',
    to: 'jane.donor@example.com',
    text: fixtureBody({}),
    dkimDomain: 'prosend.gofundme.com'
  });
  assert.equal(receipt, null);
});

test('rejects an unrelated email from the trusted address (wrong subject/body)', () => {
  const receipt = salvationArmyPlugin.parse({
    subject: 'Update your payment method',
    from: TRUSTED_FROM,
    to: 'jane.donor@example.com',
    text: 'Please update your payment method to keep your monthly donation active.',
    dkimDomain: 'prosend.gofundme.com'
  });
  assert.equal(receipt, null);
});

test('rejects when the amount is missing', () => {
  const receipt = salvationArmyPlugin.parse({
    subject: 'Thank you for your donation!',
    from: TRUSTED_FROM,
    to: 'jane.donor@example.com',
    text: 'Thank you for your donation to The Salvation Army.',
    dkimDomain: 'prosend.gofundme.com'
  });
  assert.equal(receipt, null);
});

test('rejects when the recipient (To:) has no parseable email address', () => {
  const receipt = salvationArmyPlugin.parse({
    subject: 'Thank you for your donation!',
    from: TRUSTED_FROM,
    to: '',
    text: fixtureBody({}),
    dkimDomain: 'prosend.gofundme.com'
  });
  assert.equal(receipt, null);
});
