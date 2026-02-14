import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TokenRecord = {
  telegram_user_id: string;
  service: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  created_at: number;
};

export type TokenInfo = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
};

/** Buffer in seconds before actual expiry to consider a token expired */
const EXPIRY_BUFFER_SECONDS = 60;

export class TokenStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure parent directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        telegram_user_id TEXT NOT NULL,
        service TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (telegram_user_id, service)
      );
    `);
  }

  getToken(userId: string, service: string): TokenRecord | null {
    const row = this.db
      .prepare(
        "SELECT telegram_user_id, service, access_token, refresh_token, expires_at, created_at FROM tokens WHERE telegram_user_id = ? AND service = ?",
      )
      .get(userId, service) as TokenRecord | undefined;

    return row ?? null;
  }

  setToken(userId: string, service: string, token: TokenInfo): void {
    this.db
      .prepare(
        `INSERT INTO tokens (telegram_user_id, service, access_token, refresh_token, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (telegram_user_id, service) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at`,
      )
      .run(
        userId,
        service,
        token.access_token,
        token.refresh_token ?? null,
        token.expires_at ?? null,
      );
  }

  deleteToken(userId: string, service: string): void {
    this.db
      .prepare("DELETE FROM tokens WHERE telegram_user_id = ? AND service = ?")
      .run(userId, service);
  }

  isExpired(record: TokenRecord): boolean {
    if (record.expires_at === null) {
      // No expiry set — treat as not expired
      return false;
    }
    const now = Math.floor(Date.now() / 1000);
    return record.expires_at <= now + EXPIRY_BUFFER_SECONDS;
  }
}
