// Core types for the plugin system. A plugin declares which DKIM domain(s) it trusts and
// how to read a receipt out of a message from one of them; verifyDonation() only hands a
// plugin a message after its DKIM signature already verified against a trusted domain.
// Most plugins should be a data-driven RegexPlugin (regex-plugin.ts) rather than
// implementing ReceiptPlugin by hand -- see README "Adding a plugin".

export interface ReceiptPlugin {
  /** Unique, stable id, e.g. "salvation-army". Used in config and API responses. */
  id: string;
  /** Human-readable name for logs/docs. */
  name: string;
  /**
   * DKIM signing domains (the `d=` tag) this plugin trusts. A message is only handed to
   * this plugin's parse() if it carries a DKIM signature that both verified successfully
   * AND has a `d=` domain in this list. Plugins never see messages that merely claim to be
   * from these domains without a passing signature.
   */
  trustedDkimDomains: string[];
  /** Static display info for this charity, e.g. for a donation-picker UI. See CharityInfo. */
  charityInfo: CharityInfo;
  /**
   * Try to extract a donation receipt from a DKIM-verified message.
   * Return null if this message doesn't look like a receipt this plugin understands
   * (e.g. a different notification type from the same sending domain) -- do not throw
   * for "not a match", only for genuinely unexpected errors.
   */
  parse(message: VerifiedMessage): DonationReceipt | null;
}

/**
 * Static, human-authored info about a supported charity, for showing an end user "here's
 * who you can donate to" before they've made a donation -- distinct from DonationReceipt,
 * which describes one specific, already-made donation. Returned by `GET /charities`.
 */
export interface CharityInfo {
  /** Charity/organization name, as shown to a user picking who to donate to. */
  charityName: string;
  /** Brief, plain-language description of what the charity does. */
  description: string;
  /**
   * Currencies this charity's donation page accepts, for display purposes -- not
   * necessarily the same as any single receipt's currency, which reflects what one
   * particular donation happened to use.
   */
  supportedCurrencies: string[];
  /** URL where a user can actually go make a donation to this charity. */
  donateLink: string;
}

/** A DKIM-verified email, with just the fields plugins need to parse a receipt. */
export interface VerifiedMessage {
  subject: string;
  from: EmailAddress;
  /** Recipients from the To: header -- the donor's own email address is almost always here, not in the body. */
  to: EmailAddress[];
  text?: string;
  html?: string;
  /** The DKIM d= domain that produced a passing signature for this message. */
  dkimDomain: string;
}

export interface EmailAddress {
  name: string;
  /** Lowercased. */
  address: string;
}

export interface DonationReceipt {
  /** Human-readable charity/organization name, as it appears on the receipt. */
  charityName: string;
  /** Donation amount in the currency's major unit (e.g. dollars, not cents). */
  amount: number;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
  /** Email address the receipt was addressed to / associated with the donor account. */
  donorEmail: string;
  /** When the donation was made, per the receipt. */
  donatedAt: Date;
  /** Optional transaction/confirmation id, for operator logs and debugging only. */
  transactionId?: string;
}
