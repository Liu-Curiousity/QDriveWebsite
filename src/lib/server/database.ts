import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { VerifiedAuthingUser } from './authing';

const databasePath =
  process.env.QDRIVE_DATABASE_PATH ||
  join(process.cwd(), 'data', 'qdrive.sqlite');

mkdirSync(dirname(databasePath), { recursive: true });

const database = new DatabaseSync(databasePath);
database.exec('PRAGMA journal_mode = WAL;');
database.exec('PRAGMA foreign_keys = ON;');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    authing_user_id TEXT NOT NULL UNIQUE,
    username TEXT,
    email TEXT,
    phone TEXT,
    display_name TEXT,
    avatar_url TEXT,
    raw_profile TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
  CREATE INDEX IF NOT EXISTS users_phone_idx ON users(phone);
`);

const userColumns = new Set(
  (
    database.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
  ).map((column) => column.name),
);

if (!userColumns.has('custom_display_name')) {
  database.exec('ALTER TABLE users ADD COLUMN custom_display_name TEXT;');
}
if (!userColumns.has('custom_avatar_mime')) {
  database.exec('ALTER TABLE users ADD COLUMN custom_avatar_mime TEXT;');
}
if (!userColumns.has('custom_avatar_data')) {
  database.exec('ALTER TABLE users ADD COLUMN custom_avatar_data BLOB;');
}

export interface SiteUser {
  id: string;
  authingUserId: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  customDisplayName: string | null;
  hasCustomAvatar: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}

type UserRow = {
  id: string;
  authing_user_id: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  display_name: string | null;
  avatar_url: string | null;
  custom_display_name: string | null;
  custom_avatar_mime: string | null;
  custom_avatar_data: Uint8Array | null;
  created_at: string;
  updated_at: string;
  last_login_at: string;
};

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const toSiteUser = (row: UserRow): SiteUser => ({
  id: row.id,
  authingUserId: row.authing_user_id,
  username: row.username,
  email: row.email,
  phone: row.phone,
  displayName: row.custom_display_name || row.display_name,
  avatarUrl: row.custom_avatar_data
    ? `/api/account/avatar/${encodeURIComponent(row.id)}?v=${encodeURIComponent(row.updated_at)}`
    : row.avatar_url,
  customDisplayName: row.custom_display_name,
  hasCustomAvatar: Boolean(row.custom_avatar_data),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastLoginAt: row.last_login_at,
});

export function upsertAuthingUser(profile: VerifiedAuthingUser): SiteUser {
  const now = new Date().toISOString();
  const username = asString(profile.preferred_username ?? profile.username);
  const email = asString(profile.email);
  const phone = asString(profile.phone_number ?? profile.phoneNumber ?? profile.phone);
  const displayName = asString(
    profile.name ?? profile.nickname ?? username ?? email ?? phone,
  );
  const avatarUrl = asString(profile.picture ?? profile.photo);

  const row = database
    .prepare(`
      INSERT INTO users (
        id,
        authing_user_id,
        username,
        email,
        phone,
        display_name,
        avatar_url,
        raw_profile,
        created_at,
        updated_at,
        last_login_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(authing_user_id) DO UPDATE SET
        username = excluded.username,
        email = excluded.email,
        phone = excluded.phone,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        raw_profile = excluded.raw_profile,
        updated_at = excluded.updated_at,
        last_login_at = excluded.last_login_at
      RETURNING
        id,
        authing_user_id,
        username,
        email,
        phone,
        display_name,
        avatar_url,
        custom_display_name,
        custom_avatar_mime,
        custom_avatar_data,
        created_at,
        updated_at,
        last_login_at
    `)
    .get(
      randomUUID(),
      profile.sub,
      username,
      email,
      phone,
      displayName,
      avatarUrl,
      JSON.stringify(profile),
      now,
      now,
      now,
    ) as UserRow;

  return toSiteUser(row);
}

const siteUserColumns = `
  id,
  authing_user_id,
  username,
  email,
  phone,
  display_name,
  avatar_url,
  custom_display_name,
  custom_avatar_mime,
  custom_avatar_data,
  created_at,
  updated_at,
  last_login_at
`;

export function getUserByAuthingId(authingUserId: string): SiteUser | null {
  const row = database
    .prepare(`SELECT ${siteUserColumns} FROM users WHERE authing_user_id = ?`)
    .get(authingUserId) as UserRow | undefined;
  return row ? toSiteUser(row) : null;
}

export function updateSiteProfile(
  authingUserId: string,
  input: {
    displayName?: string | null;
    avatar?: { mime: string; data: Uint8Array } | null;
  },
): SiteUser {
  const updates: string[] = [];
  const values: Array<string | Uint8Array | null> = [];

  if (input.displayName !== undefined) {
    updates.push('custom_display_name = ?');
    values.push(input.displayName);
  }
  if (input.avatar !== undefined) {
    updates.push('custom_avatar_mime = ?', 'custom_avatar_data = ?');
    values.push(input.avatar?.mime ?? null, input.avatar?.data ?? null);
  }
  if (!updates.length) {
    const user = getUserByAuthingId(authingUserId);
    if (!user) throw new Error('User does not exist.');
    return user;
  }

  updates.push('updated_at = ?');
  values.push(new Date().toISOString(), authingUserId);
  const row = database
    .prepare(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE authing_user_id = ?
      RETURNING ${siteUserColumns}
    `)
    .get(...values) as UserRow | undefined;

  if (!row) throw new Error('User does not exist.');
  return toSiteUser(row);
}

export function getUserAvatar(siteUserId: string) {
  const row = database
    .prepare(`
      SELECT custom_avatar_mime AS mime, custom_avatar_data AS data
      FROM users
      WHERE id = ?
    `)
    .get(siteUserId) as { mime: string | null; data: Uint8Array | null } | undefined;

  if (!row?.mime || !row.data) return null;
  return row as { mime: string; data: Uint8Array };
}

export function getDatabaseStatus() {
  const row = database.prepare('SELECT COUNT(*) AS count FROM users').get() as {
    count: number;
  };

  return {
    ready: true,
    users: Number(row.count),
  };
}
