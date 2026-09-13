import type { DonationReceipt, ReceiptPlugin, VerifiedMessage } from '../../types.js';
import { bodyText, firstEmailAddress, parseAmount } from '../util.js';

// Verified against a real "Thank you for your donation!" receipt (2026-09-12).
//
// The Salvation Army doesn't send receipts from its own domain -- like many charities it
// processes donations through a third-party platform, GoFundMe Charity, whose transactional
// mail is DKIM-signed under `prosend.gofundme.com`. That domain is shared across every
// charity/campaign on the platform, so a passing DKIM signature from it only proves "some
// GoFundMe Charity page sent this", not "The Salvation Army sent this". The thing that
// actually identifies the charity is the From address's subdomain, which GoFundMe assigns
// per-charity account -- and because `From` is in the DKIM-signed header list (confirmed in
// the sample's h= tag), that address can't be forged without invalidating the signature. So
// trust here is anchored to this exact From address, not just the signing domain.
const SIGNING_DOMAIN = 'prosend.gofundme.com';
const TRUSTED_FROM_ADDRESS = 'info@the-salvation-army-national-corp.prosend.gofundme.com';

const RECEIPT_SUBJECT_PATTERN = /thank you|donation|receipt/i;
// "Donation amount" (money that reaches the charity) rather than "Total" (which can include
// an optional donor-paid fee-cover/tip that goes to the platform, not the charity).
const AMOUNT_PATTERN = /donation amount\s*\$?\s*([\d,]+\.\d{2})/i;
const DATE_PATTERN = /donation date\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i;

export const salvationArmyPlugin: ReceiptPlugin = {
  id: 'salvation-army',
  name: 'The Salvation Army (via GoFundMe Charity)',
  trustedDkimDomains: [SIGNING_DOMAIN],

  parse(message: VerifiedMessage): DonationReceipt | null {
    if (!message.from.toLowerCase().includes(TRUSTED_FROM_ADDRESS)) return null;
    if (!RECEIPT_SUBJECT_PATTERN.test(message.subject)) return null;

    const text = bodyText(message);

    const amountMatch = text.match(AMOUNT_PATTERN);
    if (!amountMatch) return null;
    const amount = parseAmount(amountMatch[1]);
    if (amount === null) return null;

    const dateMatch = text.match(DATE_PATTERN);
    const donatedAt = dateMatch ? new Date(dateMatch[1]) : null;
    if (!donatedAt || Number.isNaN(donatedAt.getTime())) return null;

    const donorEmail = firstEmailAddress(message.to);
    if (!donorEmail) return null;

    return {
      charityName: 'The Salvation Army',
      amount,
      currency: 'USD',
      donorEmail,
      donatedAt
    };
  }
};
