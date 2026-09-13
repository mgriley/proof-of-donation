import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export class ReceiptStore {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS used_receipts (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        claimed_email TEXT NOT NULL,
        used_at INTEGER NOT NULL
      )
    `);
  }

  /**
   * Atomically claims a receipt id. Returns true the first time a given id is claimed,
   * false on every subsequent attempt -- this is what stops one receipt validating
   * more than one signup.
   */
  claim(id: string, pluginId: string, claimedEmail: string): boolean {
    try {
      this.#db
        .prepare('INSERT INTO used_receipts (id, plugin_id, claimed_email, used_at) VALUES (?, ?, ?, ?)')
        .run(id, pluginId, claimedEmail.toLowerCase(), Date.now());
      return true;
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        return false;
      }
      throw err;
    }
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Derives a stable replay-detection id from a message's DKIM-Signature header(s).
 *
 * The signature bytes (the `b=` tag) are unique per signing operation, so hashing the
 * raw signature header line(s) is a more robust dedup key than Message-ID: Message-ID
 * isn't always covered by the signed header list (`h=`), so a forwarding/relaying step
 * could in principle change it without invalidating the signature, which would defeat
 * dedup if we keyed on it instead.
 */
export function receiptIdFor(dkimSignatureHeaderLines: string[]): string {
  const basis = [...dkimSignatureHeaderLines].sort().join('\n');
  return crypto.createHash('sha256').update(basis).digest('hex');
}
