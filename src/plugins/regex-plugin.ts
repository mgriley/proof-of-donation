import type { DonationReceipt, ReceiptPlugin, VerifiedMessage } from './plugin.js';
import { bodyText, parseAmount } from './util.js';

/**
 * Plain-data description of a charity/platform's receipt template. This is the primary way
 * to add support for a new charity: no code, no npm install, just a JSON file describing
 * where to trust it from and how to read its receipt. See plugins/salvation-army.json for a
 * real example, and README "Adding a plugin" for how to build one.
 *
 * For a template that genuinely can't be expressed this way (e.g. the amount is only in a
 * PDF attachment, not the body), implement `ReceiptPlugin` directly instead and load it via
 * EXTERNAL_PLUGINS -- that's the advanced escape hatch, not the default path.
 */
export interface RegexPluginDescriptor {
  /** Unique, stable, lowercase-with-hyphens id, e.g. "salvation-army". */
  id: string;
  /** Human-readable name for logs/docs. */
  name: string;
  /** Charity name to report in a successful result, and to show a user picking who to donate to. */
  charityName: string;
  /** Brief, plain-language description of what the charity does, for a donation-picker UI. */
  description: string;
  /** Currencies this charity's donation page accepts, for display purposes. */
  supportedCurrencies: string[];
  /** URL where a user can actually go make a donation to this charity. */
  donateLink: string;
  /**
   * ISO 4217 currency code this template's amountPattern is written to extract, e.g. "USD".
   * A parsing detail, not necessarily the same list as supportedCurrencies -- one receipt
   * reflects whatever currency that particular donation happened to use.
   */
  currency: string;
  /** DKIM `d=` domains this plugin trusts. */
  trustedDkimDomains: string[];
  /**
   * Exact From address required, e.g. "info@some-charity.prosend.gofundme.com". Required
   * when trustedDkimDomains is a shared platform domain (GoFundMe Charity, Classy, etc.)
   * used by many charities -- without this, any receipt from that platform would match.
   * Omit only when the domain itself is charity-specific and sufficient on its own.
   */
  trustedFromAddress?: string;
  /** Regex tested against the message subject (case-insensitive). No capture group needed. */
  subjectPattern: string;
  /** Regex with one capture group: the donation amount, e.g. "12.34" (case-insensitive). */
  amountPattern: string;
  /** Regex with one capture group: a Date-parseable date string (case-insensitive). */
  datePattern: string;
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function assertNonEmptyString(value: unknown, field: string, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`plugin "${context}": "${field}" must be a non-empty string`);
  }
  return value;
}

function compileRegex(pattern: string, field: string, context: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    throw new Error(`plugin "${context}": "${field}" is not a valid regular expression: ${(err as Error).message}`);
  }
}

function assertCurrencyCode(value: unknown, field: string, context: string): string {
  const currency = assertNonEmptyString(value, field, context).toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new Error(`plugin "${context}": "${field}" must be a 3-letter ISO 4217 code, e.g. "USD"`);
  }
  return currency;
}

function assertHttpsUrl(value: unknown, field: string, context: string): string {
  const url = assertNonEmptyString(value, field, context);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`plugin "${context}": "${field}" must be a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`plugin "${context}": "${field}" must be an https:// URL`);
  }
  return url;
}

/** Validates a RegexPluginDescriptor and compiles it into a ReceiptPlugin. Throws on any
 * malformed field, naming the offending plugin id and field so a bad file fails loudly at
 * startup rather than silently matching nothing (or worse, matching too much). */
export function compileRegexPlugin(descriptor: RegexPluginDescriptor): ReceiptPlugin {
  const id = assertNonEmptyString(descriptor?.id, 'id', descriptor?.id || '(missing id)');
  if (!ID_PATTERN.test(id)) {
    throw new Error(`plugin "${id}": "id" must be lowercase alphanumeric with optional hyphens`);
  }
  const name = assertNonEmptyString(descriptor.name, 'name', id);
  const charityName = assertNonEmptyString(descriptor.charityName, 'charityName', id);
  const description = assertNonEmptyString(descriptor.description, 'description', id);
  const donateLink = assertHttpsUrl(descriptor.donateLink, 'donateLink', id);
  if (!Array.isArray(descriptor.supportedCurrencies) || descriptor.supportedCurrencies.length === 0) {
    throw new Error(`plugin "${id}": "supportedCurrencies" must be a non-empty array of currency codes`);
  }
  const supportedCurrencies = descriptor.supportedCurrencies.map((c, i) =>
    assertCurrencyCode(c, `supportedCurrencies[${i}]`, id)
  );
  const currency = assertCurrencyCode(descriptor.currency, 'currency', id);
  if (!Array.isArray(descriptor.trustedDkimDomains) || descriptor.trustedDkimDomains.length === 0) {
    throw new Error(`plugin "${id}": "trustedDkimDomains" must be a non-empty array of domain strings`);
  }
  const trustedDkimDomains = descriptor.trustedDkimDomains.map((d, i) =>
    assertNonEmptyString(d, `trustedDkimDomains[${i}]`, id).toLowerCase()
  );
  const trustedFromAddress = descriptor.trustedFromAddress
    ? assertNonEmptyString(descriptor.trustedFromAddress, 'trustedFromAddress', id).toLowerCase()
    : undefined;

  const subjectRegex = compileRegex(assertNonEmptyString(descriptor.subjectPattern, 'subjectPattern', id), 'subjectPattern', id);
  const amountRegex = compileRegex(assertNonEmptyString(descriptor.amountPattern, 'amountPattern', id), 'amountPattern', id);
  const dateRegex = compileRegex(assertNonEmptyString(descriptor.datePattern, 'datePattern', id), 'datePattern', id);

  return {
    id,
    name,
    trustedDkimDomains,
    charityInfo: { charityName, description, supportedCurrencies, donateLink },
    parse(message: VerifiedMessage): DonationReceipt | null {
      if (trustedFromAddress && message.from.address !== trustedFromAddress) return null;
      if (!subjectRegex.test(message.subject)) return null;

      const text = bodyText(message);

      const amount = parseAmount(text.match(amountRegex)?.[1] ?? '');
      if (amount === null) return null;

      const dateText = text.match(dateRegex)?.[1];
      const donatedAt = dateText ? new Date(dateText) : null;
      if (!donatedAt || Number.isNaN(donatedAt.getTime())) return null;

      const donorEmail = message.to[0]?.address;
      if (!donorEmail) return null;

      return { charityName, amount, currency, donorEmail, donatedAt };
    }
  };
}
