export const MAX_ACCOUNT_LEVEL = 500;
export const EXPERIENCE_PER_USAGE_MINUTE = 1;
export const EXPERIENCE_PER_POINT = 10;

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

export const experienceRequiredForLevel = (level: number) => {
  const normalizedLevel = Math.max(1, Math.min(MAX_ACCOUNT_LEVEL, Math.floor(level)));
  return ((normalizedLevel - 1) * normalizedLevel * 100) / 2;
};

export const MAX_ACCOUNT_EXPERIENCE = experienceRequiredForLevel(MAX_ACCOUNT_LEVEL);

export const getExperienceProgress = (value: number): ExperienceProgress => {
  const experience = Math.max(0, Math.min(MAX_ACCOUNT_EXPERIENCE, Math.floor(Number(value) || 0)));
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
