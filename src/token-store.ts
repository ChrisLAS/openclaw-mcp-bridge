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

export type UserProfile = {
  telegram_user_id: string;
  email: string | null;
  display_name: string | null;
  tier: string;
  connected_services: string[];
  created_at: number;
  updated_at: number;
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        telegram_user_id TEXT PRIMARY KEY,
        email TEXT,
        display_name TEXT,
        tier TEXT NOT NULL DEFAULT 'free',
        connected_services TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
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

    this.addConnectedService(userId, service);
  }

  deleteToken(userId: string, service: string): void {
    this.db
      .prepare("DELETE FROM tokens WHERE telegram_user_id = ? AND service = ?")
      .run(userId, service);

    this.removeConnectedService(userId, service);
  }

  isExpired(record: TokenRecord): boolean {
    if (record.expires_at === null) {
      // No expiry set — treat as not expired
      return false;
    }
    const now = Math.floor(Date.now() / 1000);
    return record.expires_at <= now + EXPIRY_BUFFER_SECONDS;
  }

  getProfile(userId: string): UserProfile | null {
    const row = this.db
      .prepare(
        "SELECT telegram_user_id, email, display_name, tier, connected_services, created_at, updated_at FROM user_profiles WHERE telegram_user_id = ?",
      )
      .get(userId) as
      | (Omit<UserProfile, "connected_services"> & {
          connected_services: string;
        })
      | undefined;

    if (!row) return null;

    let connected_services: string[];
    try {
      const parsed = JSON.parse(row.connected_services);
      connected_services = Array.isArray(parsed) ? parsed : [];
    } catch {
      connected_services = [];
    }

    return {
      ...row,
      connected_services,
    };
  }

  upsertProfile(
    userId: string,
    data: { email?: string; display_name?: string; tier?: string },
  ): void {
    this.db
      .prepare(
        `INSERT INTO user_profiles (telegram_user_id, email, display_name, tier)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (telegram_user_id) DO UPDATE SET
           email = COALESCE(excluded.email, user_profiles.email),
           display_name = COALESCE(excluded.display_name, user_profiles.display_name),
           tier = COALESCE(excluded.tier, user_profiles.tier),
           updated_at = unixepoch()`,
      )
      .run(userId, data.email ?? null, data.display_name ?? null, data.tier ?? "free");
  }

  addConnectedService(userId: string, service: string): void {
    const profile = this.getProfile(userId);
    if (profile) {
      const services = profile.connected_services;
      if (!services.includes(service)) {
        services.push(service);
        this.db
          .prepare(
            "UPDATE user_profiles SET connected_services = ?, updated_at = unixepoch() WHERE telegram_user_id = ?",
          )
          .run(JSON.stringify(services), userId);
      }
    } else {
      this.db
        .prepare(
          `INSERT INTO user_profiles (telegram_user_id, connected_services) VALUES (?, ?)`,
        )
        .run(userId, JSON.stringify([service]));
    }
  }

  removeConnectedService(userId: string, service: string): void {
    const profile = this.getProfile(userId);
    if (!profile) return;

    const services = profile.connected_services.filter((s) => s !== service);
    this.db
      .prepare(
        "UPDATE user_profiles SET connected_services = ?, updated_at = unixepoch() WHERE telegram_user_id = ?",
      )
      .run(JSON.stringify(services), userId);
  }
}
