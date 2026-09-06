export const MAX_ACCOUNT_LEVEL = 100;
export const EXPERIENCE_REQUIRED_FOR_MAX_LEVEL = 500_000;
export const EXPERIENCE_PER_USAGE_MINUTE = 1;
export const EXPERIENCE_PER_POINT = 10;

const LEVEL_EXPERIENCE_GRADIENTS = [
  { maxLevel: 20, multiplier: 0.6 },
  { maxLevel: 40, multiplier: 0.75 },
  { maxLevel: 60, multiplier: 0.9 },
  { maxLevel: 80, multiplier: 1.05 },
  { maxLevel: MAX_ACCOUNT_LEVEL, multiplier: 1.18 },
] as const;

export interface ExperienceProgress {
  experience: number;
  level: number;
  levelStartExperience: number;
  nextLevelExperience: number | null;
  experienceIntoLevel: number;
  experienceForNextLevel: number | null;
  experienceToNextLevel: number | null;
  progress: number;
}

const experienceRequiredForNextLevel = (level: number) => {
  const gradient = LEVEL_EXPERIENCE_GRADIENTS.find(({ maxLevel }) => level <= maxLevel);
  return Math.round(level * 100 * (gradient?.multiplier ?? 1));
};

const RAW_LEVEL_EXPERIENCE_THRESHOLDS = Array.from(
  { length: MAX_ACCOUNT_LEVEL },
  (_, index) => index + 1,
).reduce<number[]>((thresholds, level) => {
  if (level === 1) return [0];
  return [
    ...thresholds,
    thresholds[level - 2] + experienceRequiredForNextLevel(level - 1),
  ];
}, []);

const rawMaximumExperience = RAW_LEVEL_EXPERIENCE_THRESHOLDS[MAX_ACCOUNT_LEVEL - 1];
const LEVEL_EXPERIENCE_THRESHOLDS = RAW_LEVEL_EXPERIENCE_THRESHOLDS.map((experience) =>
  Math.round((experience / rawMaximumExperience) * EXPERIENCE_REQUIRED_FOR_MAX_LEVEL),
);

export const experienceRequiredForLevel = (level: number) => {
  const normalizedLevel = Math.max(
    1,
    Math.min(MAX_ACCOUNT_LEVEL, Number.isFinite(level) ? Math.floor(level) : 1),
  );
  return LEVEL_EXPERIENCE_THRESHOLDS[normalizedLevel - 1];
};

export const getExperienceProgress = (value: number): ExperienceProgress => {
  const numericExperience = Number(value);
  const experience = Math.max(
    0,
    Number.isFinite(numericExperience) ? Math.floor(numericExperience) : 0,
  );
  let low = 1;
  let high = MAX_ACCOUNT_LEVEL;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (experienceRequiredForLevel(middle) <= experience) low = middle;
    else high = middle - 1;
  }

  const level = low;
  const levelStartExperience = experienceRequiredForLevel(level);
  if (level === MAX_ACCOUNT_LEVEL) {
    return {
      experience,
      level,
      levelStartExperience,
      nextLevelExperience: null,
      experienceIntoLevel: experience - levelStartExperience,
      experienceForNextLevel: null,
      experienceToNextLevel: null,
      progress: 1,
    };
  }

  const nextLevelExperience = experienceRequiredForLevel(level + 1);
  const experienceForNextLevel = nextLevelExperience - levelStartExperience;
  const experienceIntoLevel = experience - levelStartExperience;
  return {
    experience,
    level,
    levelStartExperience,
    nextLevelExperience,
    experienceIntoLevel,
    experienceForNextLevel,
    experienceToNextLevel: nextLevelExperience - experience,
    progress: experienceIntoLevel / experienceForNextLevel,
  };
};
