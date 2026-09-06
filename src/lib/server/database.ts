import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { VerifiedAuthingUser } from './authing';
import {
  EXPERIENCE_PER_POINT,
  EXPERIENCE_PER_USAGE_MINUTE,
  getExperienceProgress,
} from '../experience';

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
if (!userColumns.has('experience')) {
  database.exec('ALTER TABLE users ADD COLUMN experience INTEGER NOT NULL DEFAULT 0;');
  database.prepare(`
    UPDATE users
    SET experience = MAX(0, points) * ?
  `).run(EXPERIENCE_PER_POINT);
}
if (!userColumns.has('usage_seconds')) {
  database.exec('ALTER TABLE users ADD COLUMN usage_seconds INTEGER NOT NULL DEFAULT 0;');
}
if (!userColumns.has('last_usage_at')) {
  database.exec('ALTER TABLE users ADD COLUMN last_usage_at TEXT;');
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

  CREATE TABLE IF NOT EXISTS lottery_submissions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    shipping_address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    review_note TEXT,
    reviewer_authing_user_id TEXT,
    reviewer_name TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS lottery_attachments (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(submission_id) REFERENCES lottery_submissions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS lottery_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'probability' CHECK(mode IN ('probability', 'count')),
    first_probability INTEGER NOT NULL DEFAULT 5,
    second_probability INTEGER NOT NULL DEFAULT 15,
    third_probability INTEGER NOT NULL DEFAULT 30,
    first_count INTEGER NOT NULL DEFAULT 1,
    second_count INTEGER NOT NULL DEFAULT 3,
    third_count INTEGER NOT NULL DEFAULT 10,
    updated_at TEXT NOT NULL
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

  CREATE TABLE IF NOT EXISTS experience_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    reference_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS point_mall_products (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL,
    points_cost INTEGER NOT NULL CHECK(points_cost > 0),
    stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
    visual_key TEXT NOT NULL DEFAULT 'parts',
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS point_mall_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    unit_points INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    total_points INTEGER NOT NULL,
    recipient_name TEXT NOT NULL,
    recipient_phone TEXT NOT NULL,
    shipping_address TEXT NOT NULL,
    customer_note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'shipped', 'completed', 'cancelled')),
    admin_note TEXT,
    operator_authing_user_id TEXT,
    operator_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(product_id) REFERENCES point_mall_products(id)
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
  CREATE INDEX IF NOT EXISTS lottery_submissions_user_idx
    ON lottery_submissions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS lottery_submissions_status_idx
    ON lottery_submissions(status, created_at ASC);
  CREATE INDEX IF NOT EXISTS lottery_attachments_submission_idx
    ON lottery_attachments(submission_id);
  CREATE INDEX IF NOT EXISTS user_messages_user_idx
    ON user_messages(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS experience_events_user_idx
    ON experience_events(user_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS experience_events_reference_idx
    ON experience_events(user_id, source, reference_id)
    WHERE reference_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS point_mall_products_active_idx
    ON point_mall_products(active, sort_order, points_cost);
  CREATE INDEX IF NOT EXISTS point_mall_orders_user_idx
    ON point_mall_orders(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS point_mall_orders_status_idx
    ON point_mall_orders(status, created_at ASC);
`);

const experienceReferenceIndex = database.prepare(`
  SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'experience_events_reference_idx'
`).get() as { sql: string | null } | undefined;
if (experienceReferenceIndex?.sql && !/\buser_id\b/i.test(experienceReferenceIndex.sql)) {
  database.exec('DROP INDEX experience_events_reference_idx;');
  database.exec(`
    CREATE UNIQUE INDEX experience_events_reference_idx
    ON experience_events(user_id, source, reference_id)
    WHERE reference_id IS NOT NULL;
  `);
}

database.prepare(`INSERT OR IGNORE INTO lottery_settings (id, updated_at) VALUES (1, ?)`).run(new Date().toISOString());

const seedPointMallProduct = database.prepare(`
  INSERT OR IGNORE INTO point_mall_products
    (id, slug, name, summary, category, points_cost, stock, visual_key, active, sort_order, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
`);
const pointMallSeededAt = new Date().toISOString();
const pointMallSeedProducts = [
  ['mall-badge-set', 'qdrive-badge-set', 'QDrive 金属徽章套装', '三枚装金属徽章，适合背包、工作服或收藏展示。', '品牌周边', 180, 80, 'badge', 10],
  ['mall-usbc-cable', 'usb-c-debug-cable', 'USB-C 调试数据线', '1 米编织数据线，适合设备调参、固件更新与日常开发。', '开发配件', 360, 40, 'cable', 20],
  ['mall-xt30-harness', 'xt30-power-harness', 'XT30 电源线束', '带保护套的 XT30 电源线束，为 QD4310 开发接线准备。', '开发配件', 520, 25, 'harness', 30],
  ['mall-desk-kit', 'qdrive-desk-kit', 'QDrive 工程师桌面套装', '包含收纳包、贴纸、徽章和调试数据线的限定组合。', '限定礼品', 1200, 12, 'kit', 40],
] as const;
pointMallSeedProducts.forEach((product) => seedPointMallProduct.run(...product, pointMallSeededAt, pointMallSeededAt));

const lotteryColumns = new Set(
  (database.prepare('PRAGMA table_info(lottery_submissions)').all() as Array<{ name: string }>).map((column) => column.name),
);
if (!lotteryColumns.has('prize_level')) database.exec('ALTER TABLE lottery_submissions ADD COLUMN prize_level TEXT;');
if (!lotteryColumns.has('drawn_at')) database.exec('ALTER TABLE lottery_submissions ADD COLUMN drawn_at TEXT;');

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
  experience: number;
  level: number;
  levelStartExperience: number;
  nextLevelExperience: number | null;
  experienceIntoLevel: number;
  experienceForNextLevel: number | null;
  experienceToNextLevel: number | null;
  levelProgress: number;
  usageSeconds: number;
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
  experience: number;
  usage_seconds: number;
  created_at: string;
  updated_at: string;
  last_login_at: string;
};

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const toSiteUser = (row: UserRow): SiteUser => {
  const experience = getExperienceProgress(row.experience);
  return {
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
    experience: experience.experience,
    level: experience.level,
    levelStartExperience: experience.levelStartExperience,
    nextLevelExperience: experience.nextLevelExperience,
    experienceIntoLevel: experience.experienceIntoLevel,
    experienceForNextLevel: experience.experienceForNextLevel,
    experienceToNextLevel: experience.experienceToNextLevel,
    levelProgress: experience.progress,
    usageSeconds: Math.max(0, Number(row.usage_seconds || 0)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
};

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
        experience,
        usage_seconds,
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
  experience,
  usage_seconds,
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
  let awardedExperience = 0;
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
      awardedExperience = awardExperienceByUserId(
        existing.user_id,
        awardedPoints * EXPERIENCE_PER_POINT,
        'points',
        `contribution:${submissionId}`,
        `${awardedPoints} contribution points`,
        now,
      );
    }
    const title = input.status === 'approved' ? '开发贡献审核通过' : '开发贡献审核结果';
    const experienceText = awardedExperience > 0
      ? `，同时获得 ${awardedExperience} 经验`
      : '';
    const content = input.status === 'approved'
      ? `你的开发贡献已通过审核，获得 ${awardedPoints || 0} 积分${experienceText}。${input.note ? ` ${input.note}` : ''}`
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

export interface LotterySubmission {
  id: string;
  userId: string;
  authingUserId: string;
  userName: string;
  content: string;
  shippingAddress: string;
  status: ContributionStatus;
  prizeLevel: 'first' | 'second' | 'third' | null;
  drawnAt: string | null;
  reviewNote: string | null;
  reviewerName: string | null;
  createdAt: string;
  reviewedAt: string | null;
  attachments: Array<{ id: string; name: string; mime: string; size: number }>;
}

type LotteryRow = {
  id: string;
  user_id: string;
  authing_user_id: string;
  user_name: string | null;
  content: string;
  shipping_address: string;
  status: ContributionStatus;
  prize_level: 'first' | 'second' | 'third' | null;
  drawn_at: string | null;
  review_note: string | null;
  reviewer_name: string | null;
  created_at: string;
  reviewed_at: string | null;
};

const lotterySelect = `
  SELECT
    submission.id,
    submission.user_id,
    users.authing_user_id,
    COALESCE(users.custom_display_name, users.display_name, users.username) AS user_name,
    submission.content,
    submission.shipping_address,
    submission.status,
    submission.prize_level,
    submission.drawn_at,
    submission.review_note,
    submission.reviewer_name,
    submission.created_at,
    submission.reviewed_at
  FROM lottery_submissions AS submission
  JOIN users ON users.id = submission.user_id
`;

const toLottery = (row: LotteryRow): LotterySubmission => {
  const attachments = database.prepare(`
    SELECT id, name, mime, length(data) AS size
    FROM lottery_attachments
    WHERE submission_id = ?
    ORDER BY created_at ASC
  `).all(row.id) as Array<{ id: string; name: string; mime: string; size: number }>;
  return {
    id: row.id,
    userId: row.user_id,
    authingUserId: row.authing_user_id,
    userName: row.user_name || 'QDrive 用户',
    content: row.content,
    shippingAddress: row.shipping_address,
    status: row.status,
    prizeLevel: row.prize_level,
    drawnAt: row.drawn_at,
    reviewNote: row.review_note,
    reviewerName: row.reviewer_name,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    attachments,
  };
};

export function createLotterySubmission(
  authingUserId: string,
  content: string,
  shippingAddress: string,
  attachments: Array<{ name: string; mime: string; data: Uint8Array }>,
) {
  const user = getUserByAuthingId(authingUserId);
  if (!user) throw new Error('User does not exist.');
  const id = randomUUID();
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.prepare(`
      INSERT INTO lottery_submissions (id, user_id, content, shipping_address, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(id, user.id, content, shippingAddress, now);
    const insertAttachment = database.prepare(`
      INSERT INTO lottery_attachments (id, submission_id, name, mime, data, created_at)
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
  return toLottery(database.prepare(`${lotterySelect} WHERE submission.id = ?`).get(id) as LotteryRow);
}

export function listUserLotterySubmissions(authingUserId: string) {
  const rows = database.prepare(`
    ${lotterySelect}
    WHERE users.authing_user_id = ?
    ORDER BY submission.created_at DESC
  `).all(authingUserId) as LotteryRow[];
  return rows.map(toLottery);
}

export function listAllLotterySubmissions() {
  const rows = database.prepare(`
    ${lotterySelect}
    ORDER BY CASE submission.status WHEN 'pending' THEN 0 ELSE 1 END, submission.created_at DESC
  `).all() as LotteryRow[];
  return rows.map(toLottery);
}

export function getLotteryAttachment(attachmentId: string) {
  return database.prepare(`
    SELECT attachment.mime, attachment.name, attachment.data, users.authing_user_id
    FROM lottery_attachments AS attachment
    JOIN lottery_submissions AS submission ON submission.id = attachment.submission_id
    JOIN users ON users.id = submission.user_id
    WHERE attachment.id = ?
  `).get(attachmentId) as {
    mime: string;
    name: string;
    data: Uint8Array;
    authing_user_id: string;
  } | undefined;
}

export function reviewLotterySubmission(
  submissionId: string,
  input: { status: 'approved' | 'rejected'; note: string | null; reviewer: { authingUserId: string; name: string } },
) {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const existing = database.prepare(`
      SELECT id, user_id, status FROM lottery_submissions WHERE id = ?
    `).get(submissionId) as { id: string; user_id: string; status: ContributionStatus } | undefined;
    if (!existing) throw new Error('Lottery submission does not exist.');
    if (existing.status !== 'pending') throw new Error('Lottery submission has already been reviewed.');
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE lottery_submissions
      SET status = ?, review_note = ?, reviewer_authing_user_id = ?, reviewer_name = ?, reviewed_at = ?
      WHERE id = ?
    `).run(input.status, input.note, input.reviewer.authingUserId, input.reviewer.name, now, submissionId);
    const title = input.status === 'approved' ? '抽奖凭证审核通过' : '抽奖凭证审核结果';
    const content = input.status === 'approved'
      ? `你的抽奖凭证已审核通过。${input.note ? ` ${input.note}` : ''}`
      : `你的抽奖凭证未通过审核。${input.note ? ` ${input.note}` : ''}`;
    insertUserMessage(existing.user_id, 'lottery', title, content, now);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  return toLottery(database.prepare(`${lotterySelect} WHERE submission.id = ?`).get(submissionId) as LotteryRow);
}

export interface LotterySettings {
  enabled: boolean;
  mode: 'probability' | 'count';
  firstProbability: number;
  secondProbability: number;
  thirdProbability: number;
  firstCount: number;
  secondCount: number;
  thirdCount: number;
  updatedAt: string;
}

const toLotterySettings = (row: Record<string, unknown>): LotterySettings => ({
  enabled: Boolean(row.enabled),
  mode: row.mode === 'count' ? 'count' : 'probability',
  firstProbability: Number(row.first_probability),
  secondProbability: Number(row.second_probability),
  thirdProbability: Number(row.third_probability),
  firstCount: Number(row.first_count),
  secondCount: Number(row.second_count),
  thirdCount: Number(row.third_count),
  updatedAt: String(row.updated_at),
});

export function getLotterySettings() {
  const row = database.prepare('SELECT * FROM lottery_settings WHERE id = 1').get() as Record<string, unknown>;
  return toLotterySettings(row);
}

export function updateLotterySettings(input: Omit<LotterySettings, 'updatedAt'>) {
  const now = new Date().toISOString();
  database.prepare(`UPDATE lottery_settings SET enabled = ?, mode = ?, first_probability = ?, second_probability = ?, third_probability = ?, first_count = ?, second_count = ?, third_count = ?, updated_at = ? WHERE id = 1`)
    .run(input.enabled ? 1 : 0, input.mode, input.firstProbability, input.secondProbability, input.thirdProbability, input.firstCount, input.secondCount, input.thirdCount, now);
  return getLotterySettings();
}

export function drawLottery() {
  const settings = getLotterySettings();
  if (!settings.enabled) throw new Error('请先开启抽奖。');
  const entries = database.prepare(`SELECT id, user_id FROM lottery_submissions WHERE drawn_at IS NULL ORDER BY created_at ASC`).all() as Array<{ id: string; user_id: string }>;
  if (!entries.length) throw new Error('暂无可参与抽奖的申请。');
  const winners = new Map<string, 'first' | 'second' | 'third'>();
  const pool = [...entries];
  const take = (level: 'first' | 'second' | 'third', count: number) => {
    for (let i = 0; i < count && pool.length; i += 1) {
      const index = Math.floor(Math.random() * pool.length);
      const winner = pool.splice(index, 1)[0];
      winners.set(winner.id, level);
    }
  };
  if (settings.mode === 'count') {
    take('first', settings.firstCount); take('second', settings.secondCount); take('third', settings.thirdCount);
  } else {
    for (let i = pool.length - 1; i >= 0; i -= 1) {
      const roll = Math.random() * 100;
      const level = roll < settings.firstProbability ? 'first' : roll < settings.firstProbability + settings.secondProbability ? 'second' : roll < settings.firstProbability + settings.secondProbability + settings.thirdProbability ? 'third' : null;
      if (level) winners.set(pool[i].id, level);
    }
  }
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE;');
  try {
    const update = database.prepare('UPDATE lottery_submissions SET prize_level = ?, drawn_at = ? WHERE id = ?');
    const prizeLabels = { first: '一等奖', second: '二等奖', third: '三等奖' } as const;
    winners.forEach((level, id) => {
      update.run(level, now, id);
      const row = database.prepare('SELECT user_id FROM lottery_submissions WHERE id = ?').get(id) as { user_id: string };
      insertUserMessage(row.user_id, 'lottery', '抽奖结果', `恭喜你获得${prizeLabels[level]}！${settings.mode === 'count' ? '本轮抽奖结果已公布。' : ''}`, now);
    });
    database.prepare('UPDATE lottery_submissions SET drawn_at = ? WHERE drawn_at IS NULL').run(now);
    database.exec('COMMIT;');
  } catch (error) { database.exec('ROLLBACK;'); throw error; }
  return { settings, winners: winners.size, total: entries.length };
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

const awardExperienceByUserId = (
  userId: string,
  amount: number,
  source: string,
  referenceId: string | null,
  details: string | null,
  now: string,
  aggregateReference = false,
) => {
  const requestedAmount = Math.max(0, Math.floor(amount));
  if (!requestedAmount) return 0;
  let existingEventId: string | null = null;
  if (referenceId) {
    const existing = database.prepare(`
      SELECT id FROM experience_events WHERE user_id = ? AND source = ? AND reference_id = ?
    `).get(userId, source, referenceId) as { id: string } | undefined;
    if (existing && !aggregateReference) return 0;
    existingEventId = existing?.id || null;
  }
  const userExists = database.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!userExists) throw new Error('User does not exist.');
  const awardedAmount = requestedAmount;
  if (existingEventId) {
    database.prepare(`
      UPDATE experience_events SET amount = amount + ?, details = ? WHERE id = ?
    `).run(awardedAmount, details, existingEventId);
  } else {
    database.prepare(`
      INSERT INTO experience_events (id, user_id, source, amount, reference_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), userId, source, awardedAmount, referenceId, details, now);
  }
  database.prepare(`
    UPDATE users SET experience = experience + ?, updated_at = ? WHERE id = ?
  `).run(awardedAmount, now, userId);
  return awardedAmount;
};

export function awardExperience(
  authingUserId: string,
  input: { amount: number; source: string; referenceId?: string; details?: string },
) {
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE;');
  try {
    const user = getUserByAuthingId(authingUserId);
    if (!user) throw new Error('User does not exist.');
    const awarded = awardExperienceByUserId(
      user.id,
      input.amount,
      input.source,
      input.referenceId || null,
      input.details || null,
      now,
    );
    database.exec('COMMIT;');
    return { user: getUserByAuthingId(authingUserId)!, awarded };
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

export function recordUsageHeartbeat(authingUserId: string) {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  database.exec('BEGIN IMMEDIATE;');
  try {
    const row = database.prepare(`
      SELECT id, usage_seconds, last_usage_at
      FROM users WHERE authing_user_id = ?
    `).get(authingUserId) as {
      id: string;
      usage_seconds: number;
      last_usage_at: string | null;
    } | undefined;
    if (!row) throw new Error('User does not exist.');

    const previousTime = row.last_usage_at ? Date.parse(row.last_usage_at) : Number.NaN;
    const elapsedSeconds = Number.isFinite(previousTime)
      ? Math.floor((nowDate.getTime() - previousTime) / 1000)
      : 0;
    // Heartbeats normally arrive every 30 seconds. Long gaps indicate that the
    // page was hidden, suspended or offline and must not count as active use.
    const creditedSeconds = elapsedSeconds >= 1 && elapsedSeconds <= 90 ? elapsedSeconds : 0;
    const previousUsageSeconds = Math.max(0, Number(row.usage_seconds || 0));
    const usageSeconds = previousUsageSeconds + creditedSeconds;
    database.prepare(`
      UPDATE users SET usage_seconds = ?, last_usage_at = ?, updated_at = ? WHERE id = ?
    `).run(usageSeconds, now, now, row.id);

    const previousMinutes = Math.floor(previousUsageSeconds / 60);
    const usageMinutes = Math.floor(usageSeconds / 60);
    const earnedExperience = (usageMinutes - previousMinutes) * EXPERIENCE_PER_USAGE_MINUTE;
    const awarded = awardExperienceByUserId(
      row.id,
      earnedExperience,
      'usage',
      `usage:${now.slice(0, 10)}`,
      `${usageMinutes} total active minutes`,
      now,
      true,
    );
    database.exec('COMMIT;');
    return { user: getUserByAuthingId(authingUserId)!, awarded, creditedSeconds };
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

export type PointMallOrderStatus = 'pending' | 'processing' | 'shipped' | 'completed' | 'cancelled';

export interface PointMallProduct {
  id: string;
  slug: string;
  name: string;
  summary: string;
  category: string;
  pointsCost: number;
  stock: number;
  visualKey: string;
  active: boolean;
}

export interface PointMallOrder {
  id: string;
  userId: string;
  authingUserId: string;
  userName: string;
  productId: string;
  productName: string;
  unitPoints: number;
  quantity: number;
  totalPoints: number;
  recipientName: string;
  recipientPhone: string;
  shippingAddress: string;
  customerNote: string | null;
  status: PointMallOrderStatus;
  adminNote: string | null;
  operatorName: string | null;
  createdAt: string;
  updatedAt: string;
}

type PointMallProductRow = {
  id: string;
  slug: string;
  name: string;
  summary: string;
  category: string;
  points_cost: number;
  stock: number;
  visual_key: string;
  active: number;
};

type PointMallOrderRow = {
  id: string;
  user_id: string;
  authing_user_id: string;
  user_name: string | null;
  product_id: string;
  product_name: string;
  unit_points: number;
  quantity: number;
  total_points: number;
  recipient_name: string;
  recipient_phone: string;
  shipping_address: string;
  customer_note: string | null;
  status: PointMallOrderStatus;
  admin_note: string | null;
  operator_name: string | null;
  created_at: string;
  updated_at: string;
};

const toPointMallProduct = (row: PointMallProductRow): PointMallProduct => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  summary: row.summary,
  category: row.category,
  pointsCost: Number(row.points_cost),
  stock: Number(row.stock),
  visualKey: row.visual_key,
  active: Boolean(row.active),
});

const pointMallOrderSelect = `
  SELECT
    orders.id,
    orders.user_id,
    users.authing_user_id,
    COALESCE(users.custom_display_name, users.display_name, users.username) AS user_name,
    orders.product_id,
    orders.product_name,
    orders.unit_points,
    orders.quantity,
    orders.total_points,
    orders.recipient_name,
    orders.recipient_phone,
    orders.shipping_address,
    orders.customer_note,
    orders.status,
    orders.admin_note,
    orders.operator_name,
    orders.created_at,
    orders.updated_at
  FROM point_mall_orders AS orders
  JOIN users ON users.id = orders.user_id
`;

const toPointMallOrder = (row: PointMallOrderRow): PointMallOrder => ({
  id: row.id,
  userId: row.user_id,
  authingUserId: row.authing_user_id,
  userName: row.user_name || 'QDrive 用户',
  productId: row.product_id,
  productName: row.product_name,
  unitPoints: Number(row.unit_points),
  quantity: Number(row.quantity),
  totalPoints: Number(row.total_points),
  recipientName: row.recipient_name,
  recipientPhone: row.recipient_phone,
  shippingAddress: row.shipping_address,
  customerNote: row.customer_note,
  status: row.status,
  adminNote: row.admin_note,
  operatorName: row.operator_name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const getReservedRedemptionPoints = (userId: string) => {
  const row = database.prepare(`
    SELECT COALESCE(SUM(requested_points), 0) AS points
    FROM point_redemptions
    WHERE user_id = ? AND status = 'pending'
  `).get(userId) as { points: number };
  return Number(row.points || 0);
};

export function listActivePointMallProducts() {
  const rows = database.prepare(`
    SELECT id, slug, name, summary, category, points_cost, stock, visual_key, active
    FROM point_mall_products
    WHERE active = 1
    ORDER BY sort_order ASC, points_cost ASC
  `).all() as PointMallProductRow[];
  return rows.map(toPointMallProduct);
}

export function getPointMallBalance(authingUserId: string) {
  const user = getUserByAuthingId(authingUserId);
  if (!user) throw new Error('User does not exist.');
  return {
    points: user.points,
    availablePoints: Math.max(0, user.points - getReservedRedemptionPoints(user.id)),
  };
}

export function listUserPointMallOrders(authingUserId: string) {
  const rows = database.prepare(`
    ${pointMallOrderSelect}
    WHERE users.authing_user_id = ?
    ORDER BY orders.created_at DESC
    LIMIT 100
  `).all(authingUserId) as PointMallOrderRow[];
  return rows.map(toPointMallOrder);
}

export function listAllPointMallOrders() {
  const rows = database.prepare(`
    ${pointMallOrderSelect}
    ORDER BY CASE orders.status
      WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 WHEN 'shipped' THEN 2 ELSE 3 END,
      orders.created_at DESC
  `).all() as PointMallOrderRow[];
  return rows.map(toPointMallOrder);
}

export function createPointMallOrder(
  authingUserId: string,
  input: {
    productId: string;
    quantity: number;
    recipientName: string;
    recipientPhone: string;
    shippingAddress: string;
    customerNote: string | null;
  },
) {
  database.exec('BEGIN IMMEDIATE;');
  let orderId = '';
  try {
    const user = getUserByAuthingId(authingUserId);
    if (!user) throw new Error('User does not exist.');
    const productRow = database.prepare(`
      SELECT id, slug, name, summary, category, points_cost, stock, visual_key, active
      FROM point_mall_products WHERE id = ?
    `).get(input.productId) as PointMallProductRow | undefined;
    if (!productRow || !productRow.active) throw new Error('商品不存在或已下架。');
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 10) {
      throw new Error('单次兑换数量应为 1-10 的整数。');
    }
    if (productRow.stock < input.quantity) throw new Error('商品库存不足，请减少数量后重试。');

    const totalPoints = Number(productRow.points_cost) * input.quantity;
    const availablePoints = Math.max(0, user.points - getReservedRedemptionPoints(user.id));
    if (totalPoints > availablePoints) throw new Error('可用积分不足，请选择其他商品或减少数量。');

    const now = new Date().toISOString();
    orderId = randomUUID();
    const stockUpdate = database.prepare(`
      UPDATE point_mall_products SET stock = stock - ?, updated_at = ?
      WHERE id = ? AND active = 1 AND stock >= ?
    `).run(input.quantity, now, productRow.id, input.quantity);
    if (Number(stockUpdate.changes) !== 1) throw new Error('商品库存刚刚发生变化，请刷新后重试。');
    database.prepare('UPDATE users SET points = points - ?, updated_at = ? WHERE id = ?')
      .run(totalPoints, now, user.id);
    database.prepare(`
      INSERT INTO point_mall_orders (
        id, user_id, product_id, product_name, unit_points, quantity, total_points,
        recipient_name, recipient_phone, shipping_address, customer_note, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      orderId,
      user.id,
      productRow.id,
      productRow.name,
      productRow.points_cost,
      input.quantity,
      totalPoints,
      input.recipientName,
      input.recipientPhone,
      input.shippingAddress,
      input.customerNote,
      now,
      now,
    );
    insertUserMessage(
      user.id,
      'point-mall',
      '积分商城兑换成功',
      `已使用 ${totalPoints} 积分兑换 ${productRow.name} × ${input.quantity}，我们会尽快处理。`,
      now,
    );
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  const row = database.prepare(`${pointMallOrderSelect} WHERE orders.id = ?`).get(orderId) as PointMallOrderRow;
  return toPointMallOrder(row);
}

export function updatePointMallOrderStatus(
  orderId: string,
  input: {
    status: Exclude<PointMallOrderStatus, 'pending'>;
    note: string | null;
    operator: { authingUserId: string; name: string };
  },
) {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const existing = database.prepare(`
      SELECT id, user_id, product_id, product_name, quantity, total_points, status
      FROM point_mall_orders WHERE id = ?
    `).get(orderId) as {
      id: string;
      user_id: string;
      product_id: string;
      product_name: string;
      quantity: number;
      total_points: number;
      status: PointMallOrderStatus;
    } | undefined;
    if (!existing) throw new Error('商城订单不存在。');
    const transitions: Record<PointMallOrderStatus, PointMallOrderStatus[]> = {
      pending: ['processing', 'cancelled'],
      processing: ['shipped', 'cancelled'],
      shipped: ['completed'],
      completed: [],
      cancelled: [],
    };
    if (!transitions[existing.status].includes(input.status)) throw new Error('订单状态不能这样变更。');
    const now = new Date().toISOString();
    if (input.status === 'cancelled') {
      database.prepare('UPDATE users SET points = points + ?, updated_at = ? WHERE id = ?')
        .run(existing.total_points, now, existing.user_id);
      database.prepare('UPDATE point_mall_products SET stock = stock + ?, updated_at = ? WHERE id = ?')
        .run(existing.quantity, now, existing.product_id);
    }
    database.prepare(`
      UPDATE point_mall_orders
      SET status = ?, admin_note = ?, operator_authing_user_id = ?, operator_name = ?, updated_at = ?
      WHERE id = ?
    `).run(input.status, input.note, input.operator.authingUserId, input.operator.name, now, orderId);

    const statusLabels: Record<PointMallOrderStatus, string> = {
      pending: '待处理', processing: '处理中', shipped: '已发货', completed: '已完成', cancelled: '已取消',
    };
    const refund = input.status === 'cancelled' ? `，${existing.total_points} 积分已退回账户` : '';
    insertUserMessage(
      existing.user_id,
      'point-mall',
      '积分商城订单更新',
      `${existing.product_name} 的订单状态已更新为“${statusLabels[input.status]}”${refund}。${input.note ? ` ${input.note}` : ''}`,
      now,
    );
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  const row = database.prepare(`${pointMallOrderSelect} WHERE orders.id = ?`).get(orderId) as PointMallOrderRow;
  return toPointMallOrder(row);
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

export function deleteReadUserMessages(authingUserId: string) {
  const user = getUserByAuthingId(authingUserId);
  if (!user) throw new Error('User does not exist.');
  const result = database.prepare('DELETE FROM user_messages WHERE user_id = ? AND read_at IS NOT NULL')
    .run(user.id);
  return {
    deletedCount: Number(result.changes || 0),
    messages: listUserMessages(authingUserId),
  };
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
