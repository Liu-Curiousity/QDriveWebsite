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
if (!userColumns.has('points')) {
  database.exec('ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0;');
}

database.exec(`
  CREATE TABLE IF NOT EXISTS contribution_submissions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    awarded_points INTEGER,
    review_note TEXT,
    reviewer_authing_user_id TEXT,
    reviewer_name TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contribution_attachments (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(submission_id) REFERENCES contribution_submissions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS point_redemptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    taobao_account TEXT NOT NULL,
    requested_points INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    remaining_points INTEGER,
    review_note TEXT,
    reviewer_authing_user_id TEXT,
    reviewer_name TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS contribution_submissions_user_idx
    ON contribution_submissions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS contribution_submissions_status_idx
    ON contribution_submissions(status, created_at ASC);
  CREATE INDEX IF NOT EXISTS contribution_attachments_submission_idx
    ON contribution_attachments(submission_id);
  CREATE INDEX IF NOT EXISTS point_redemptions_user_idx
    ON point_redemptions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS point_redemptions_status_idx
    ON point_redemptions(status, created_at ASC);
  CREATE INDEX IF NOT EXISTS user_messages_user_idx
    ON user_messages(user_id, created_at DESC);
`);

const contributionAttachmentColumns = new Set(
  (
    database.prepare('PRAGMA table_info(contribution_attachments)').all() as Array<{ name: string }>
  ).map((column) => column.name),
);
if (!contributionAttachmentColumns.has('name')) {
  database.exec("ALTER TABLE contribution_attachments ADD COLUMN name TEXT NOT NULL DEFAULT 'attachment';");
}

const contributionColumns = new Set(
  (database.prepare('PRAGMA table_info(contribution_submissions)').all() as Array<{ name: string }>)
    .map((column) => column.name),
);
if (!contributionColumns.has('reviewer_authing_user_id')) {
  database.exec('ALTER TABLE contribution_submissions ADD COLUMN reviewer_authing_user_id TEXT;');
}
if (!contributionColumns.has('reviewer_name')) {
  database.exec('ALTER TABLE contribution_submissions ADD COLUMN reviewer_name TEXT;');
}

const redemptionColumns = new Set(
  (database.prepare('PRAGMA table_info(point_redemptions)').all() as Array<{ name: string }>)
    .map((column) => column.name),
);
if (!redemptionColumns.has('reviewer_authing_user_id')) {
  database.exec('ALTER TABLE point_redemptions ADD COLUMN reviewer_authing_user_id TEXT;');
}
if (!redemptionColumns.has('reviewer_name')) {
  database.exec('ALTER TABLE point_redemptions ADD COLUMN reviewer_name TEXT;');
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
  points: number;
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
  points: number;
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
  points: Number(row.points || 0),
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
        points,
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
  points,
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

export type ContributionStatus = 'pending' | 'approved' | 'rejected';

export interface ContributionSubmission {
  id: string;
  userId: string;
  authingUserId: string;
  userName: string;
  content: string;
  status: ContributionStatus;
  awardedPoints: number | null;
  reviewNote: string | null;
  reviewerName: string | null;
  createdAt: string;
  reviewedAt: string | null;
  attachments: Array<{ id: string; name: string; mime: string; size: number }>;
}

type ContributionRow = {
  id: string;
  user_id: string;
  authing_user_id: string;
  user_name: string | null;
  content: string;
  status: ContributionStatus;
  awarded_points: number | null;
  review_note: string | null;
  reviewer_name: string | null;
  created_at: string;
  reviewed_at: string | null;
};

const toContribution = (row: ContributionRow): ContributionSubmission => {
  const attachments = database
    .prepare(`
      SELECT id, name, mime, length(data) AS size
      FROM contribution_attachments
      WHERE submission_id = ?
      ORDER BY created_at ASC
    `)
    .all(row.id) as Array<{ id: string; name: string; mime: string; size: number }>;
  return {
    id: row.id,
    userId: row.user_id,
    authingUserId: row.authing_user_id,
    userName: row.user_name || 'QDrive 用户',
    content: row.content,
    status: row.status,
    awardedPoints: row.awarded_points,
    reviewNote: row.review_note,
    reviewerName: row.reviewer_name,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    attachments,
  };
};

const contributionSelect = `
  SELECT
    submission.id,
    submission.user_id,
    users.authing_user_id,
    COALESCE(users.custom_display_name, users.display_name, users.username) AS user_name,
    submission.content,
    submission.status,
    submission.awarded_points,
    submission.review_note,
    submission.reviewer_name,
    submission.created_at,
    submission.reviewed_at
  FROM contribution_submissions AS submission
  JOIN users ON users.id = submission.user_id
`;

export function createContributionSubmission(
  authingUserId: string,
  content: string,
  attachments: Array<{ name: string; mime: string; data: Uint8Array }>,
): ContributionSubmission {
  const user = getUserByAuthingId(authingUserId);
  if (!user) throw new Error('User does not exist.');
  const id = randomUUID();
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.prepare(`
      INSERT INTO contribution_submissions (id, user_id, content, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(id, user.id, content, now);
    const insertAttachment = database.prepare(`
      INSERT INTO contribution_attachments (id, submission_id, name, mime, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    attachments.forEach((attachment) => {
      insertAttachment.run(randomUUID(), id, attachment.name, attachment.mime, attachment.data, now);
    });
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  const row = database.prepare(`${contributionSelect} WHERE submission.id = ?`).get(id) as ContributionRow;
  return toContribution(row);
}

export function listUserContributionSubmissions(authingUserId: string) {
  const rows = database.prepare(`
    ${contributionSelect}
    WHERE users.authing_user_id = ?
    ORDER BY submission.created_at DESC
  `).all(authingUserId) as ContributionRow[];
  return rows.map(toContribution);
}

export function listAllContributionSubmissions() {
  const rows = database.prepare(`
    ${contributionSelect}
    ORDER BY
      CASE submission.status WHEN 'pending' THEN 0 ELSE 1 END,
      submission.created_at DESC
  `).all() as ContributionRow[];
  return rows.map(toContribution);
}

export function getContributionAttachment(attachmentId: string) {
  return database.prepare(`
    SELECT
      attachment.mime,
      attachment.name,
      attachment.data,
      users.authing_user_id
    FROM contribution_attachments AS attachment
    JOIN contribution_submissions AS submission ON submission.id = attachment.submission_id
    JOIN users ON users.id = submission.user_id
    WHERE attachment.id = ?
  `).get(attachmentId) as {
    mime: string;
    name: string;
    data: Uint8Array;
    authing_user_id: string;
  } | undefined;
}

export function reviewContributionSubmission(
  submissionId: string,
  input: {
    status: 'approved' | 'rejected';
    points: number | null;
    note: string | null;
    reviewer: { authingUserId: string; name: string };
  },
) {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const existing = database.prepare(`
      SELECT id, user_id, status
      FROM contribution_submissions
      WHERE id = ?
    `).get(submissionId) as { id: string; user_id: string; status: ContributionStatus } | undefined;
    if (!existing) throw new Error('Contribution does not exist.');
    if (existing.status !== 'pending') throw new Error('Contribution has already been reviewed.');
    const awardedPoints = input.status === 'approved' ? input.points : null;
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE contribution_submissions
      SET status = ?, awarded_points = ?, review_note = ?, reviewer_authing_user_id = ?, reviewer_name = ?, reviewed_at = ?
      WHERE id = ?
    `).run(
      input.status,
      awardedPoints,
      input.note,
      input.reviewer.authingUserId,
      input.reviewer.name,
      now,
      submissionId,
    );
    if (input.status === 'approved' && awardedPoints) {
      database.prepare(`
        UPDATE users
        SET points = points + ?, updated_at = ?
        WHERE id = ?
      `).run(awardedPoints, now, existing.user_id);
    }
    const title = input.status === 'approved' ? '开发贡献审核通过' : '开发贡献审核结果';
    const content = input.status === 'approved'
      ? `你的开发贡献已通过审核，获得 ${awardedPoints || 0} 积分。${input.note ? ` ${input.note}` : ''}`
      : `你的开发贡献未通过审核。${input.note ? ` ${input.note}` : ''}`;
    insertUserMessage(existing.user_id, 'contribution', title, content, now);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  const row = database.prepare(`${contributionSelect} WHERE submission.id = ?`).get(submissionId) as ContributionRow;
  return toContribution(row);
}

export type RedemptionStatus = 'pending' | 'approved' | 'rejected';

export interface PointRedemption {
  id: string;
  userId: string;
  authingUserId: string;
  userName: string;
  taobaoAccount: string;
  requestedPoints: number;
  currentPoints: number;
  status: RedemptionStatus;
  remainingPoints: number | null;
  reviewNote: string | null;
  reviewerName: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

type RedemptionRow = {
  id: string;
  user_id: string;
  authing_user_id: string;
  user_name: string | null;
  taobao_account: string;
  requested_points: number;
  current_points: number;
  status: RedemptionStatus;
  remaining_points: number | null;
  review_note: string | null;
  reviewer_name: string | null;
  created_at: string;
  reviewed_at: string | null;
};

const redemptionSelect = `
  SELECT
    redemption.id,
    redemption.user_id,
    users.authing_user_id,
    COALESCE(users.custom_display_name, users.display_name, users.username) AS user_name,
    redemption.taobao_account,
    redemption.requested_points,
    users.points AS current_points,
    redemption.status,
    redemption.remaining_points,
    redemption.review_note,
    redemption.reviewer_name,
    redemption.created_at,
    redemption.reviewed_at
  FROM point_redemptions AS redemption
  JOIN users ON users.id = redemption.user_id
`;

const toPointRedemption = (row: RedemptionRow): PointRedemption => ({
  id: row.id,
  userId: row.user_id,
  authingUserId: row.authing_user_id,
  userName: row.user_name || 'QDrive 用户',
  taobaoAccount: row.taobao_account,
  requestedPoints: Number(row.requested_points),
  currentPoints: Number(row.current_points),
  status: row.status,
  remainingPoints: row.remaining_points === null ? null : Number(row.remaining_points),
  reviewNote: row.review_note,
  reviewerName: row.reviewer_name,
  createdAt: row.created_at,
  reviewedAt: row.reviewed_at,
});

const insertUserMessage = (
  userId: string,
  type: string,
  title: string,
  content: string,
  createdAt = new Date().toISOString(),
) => {
  database.prepare(`
    INSERT INTO user_messages (id, user_id, type, title, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, type, title, content, createdAt);
};

export function createPointRedemption(
  authingUserId: string,
  taobaoAccount: string,
  requestedPoints: number,
) {
  const user = getUserByAuthingId(authingUserId);
  if (!user) throw new Error('User does not exist.');
  const pending = database.prepare(`
    SELECT COALESCE(SUM(requested_points), 0) AS points
    FROM point_redemptions
    WHERE user_id = ? AND status = 'pending'
  `).get(user.id) as { points: number };
  const availablePoints = Math.max(0, user.points - Number(pending.points || 0));
  if (requestedPoints > availablePoints) throw new Error('可兑换积分不足，请刷新后重试。');
  const id = randomUUID();
  database.prepare(`
    INSERT INTO point_redemptions (id, user_id, taobao_account, requested_points, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, user.id, taobaoAccount, requestedPoints, new Date().toISOString());
  const row = database.prepare(`${redemptionSelect} WHERE redemption.id = ?`).get(id) as RedemptionRow;
  return toPointRedemption(row);
}

export function listUserPointRedemptions(authingUserId: string) {
  const rows = database.prepare(`
    ${redemptionSelect}
    WHERE users.authing_user_id = ?
    ORDER BY redemption.created_at DESC
  `).all(authingUserId) as RedemptionRow[];
  return rows.map(toPointRedemption);
}

export function listAllPointRedemptions() {
  const rows = database.prepare(`
    ${redemptionSelect}
    ORDER BY CASE redemption.status WHEN 'pending' THEN 0 ELSE 1 END, redemption.created_at DESC
  `).all() as RedemptionRow[];
  return rows.map(toPointRedemption);
}

export function reviewPointRedemption(
  redemptionId: string,
  input: {
    status: 'approved' | 'rejected';
    remainingPoints: number | null;
    note: string | null;
    reviewer: { authingUserId: string; name: string };
  },
) {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const existing = database.prepare(`
      SELECT redemption.id, redemption.user_id, redemption.status, redemption.requested_points, users.points
      FROM point_redemptions AS redemption
      JOIN users ON users.id = redemption.user_id
      WHERE redemption.id = ?
    `).get(redemptionId) as {
      id: string;
      user_id: string;
      status: RedemptionStatus;
      requested_points: number;
      points: number;
    } | undefined;
    if (!existing) throw new Error('兑换申请不存在。');
    if (existing.status !== 'pending') throw new Error('该兑换申请已经处理。');
    if (
      input.status === 'approved' &&
      (input.remainingPoints === null || input.remainingPoints < 0 || input.remainingPoints > existing.points)
    ) throw new Error('积分余量必须在 0 到当前积分之间。');
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE point_redemptions
      SET status = ?, remaining_points = ?, review_note = ?, reviewer_authing_user_id = ?, reviewer_name = ?, reviewed_at = ?
      WHERE id = ?
    `).run(
      input.status,
      input.status === 'approved' ? input.remainingPoints : null,
      input.note,
      input.reviewer.authingUserId,
      input.reviewer.name,
      now,
      redemptionId,
    );
    if (input.status === 'approved') {
      database.prepare('UPDATE users SET points = ?, updated_at = ? WHERE id = ?')
        .run(input.remainingPoints, now, existing.user_id);
    }
    const title = input.status === 'approved' ? '积分兑换已处理' : '积分兑换审核结果';
    const content = input.status === 'approved'
      ? `你的 ${existing.requested_points} 积分兑换申请已通过，当前剩余 ${input.remainingPoints} 积分。${input.note ? ` ${input.note}` : ''}`
      : `你的 ${existing.requested_points} 积分兑换申请未通过。${input.note ? ` ${input.note}` : ''}`;
    insertUserMessage(existing.user_id, 'redemption', title, content, now);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  const row = database.prepare(`${redemptionSelect} WHERE redemption.id = ?`).get(redemptionId) as RedemptionRow;
  return toPointRedemption(row);
}

export interface UserMessage {
  id: string;
  type: string;
  title: string;
  content: string;
  readAt: string | null;
  createdAt: string;
}

export function listUserMessages(authingUserId: string) {
  const rows = database.prepare(`
    SELECT message.id, message.type, message.title, message.content, message.read_at, message.created_at
    FROM user_messages AS message
    JOIN users ON users.id = message.user_id
    WHERE users.authing_user_id = ?
    ORDER BY message.created_at DESC
    LIMIT 100
  `).all(authingUserId) as Array<{
    id: string;
    type: string;
    title: string;
    content: string;
    read_at: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    readAt: row.read_at,
    createdAt: row.created_at,
  }));
}

export function markUserMessagesRead(authingUserId: string, messageId?: string) {
  const user = getUserByAuthingId(authingUserId);
  if (!user) throw new Error('User does not exist.');
  const now = new Date().toISOString();
  if (messageId) {
    database.prepare(`UPDATE user_messages SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL`)
      .run(now, messageId, user.id);
  } else {
    database.prepare(`UPDATE user_messages SET read_at = ? WHERE user_id = ? AND read_at IS NULL`)
      .run(now, user.id);
  }
  return listUserMessages(authingUserId);
}

export function searchUsersByAccountOrEmail(query: string) {
  const normalized = query.trim();
  if (!normalized) return [];
  const escaped = normalized.replace(/[\\%_]/g, (character) => `\\${character}`);
  const pattern = `%${escaped}%`;
  const rows = database.prepare(`
    SELECT ${siteUserColumns}
    FROM users
    WHERE username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
    ORDER BY
      CASE WHEN lower(username) = lower(?) OR lower(email) = lower(?) THEN 0 ELSE 1 END,
      updated_at DESC
    LIMIT 20
  `).all(pattern, pattern, normalized, normalized) as UserRow[];
  return rows.map(toSiteUser);
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
