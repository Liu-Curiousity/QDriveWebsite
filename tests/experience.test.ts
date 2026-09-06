import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPERIENCE_REQUIRED_FOR_MAX_LEVEL,
  experienceRequiredForLevel,
  getExperienceProgress,
  MAX_ACCOUNT_LEVEL,
} from '../src/lib/experience.ts';

test('the level curve reaches level 100 at exactly 500,000 experience', () => {
  assert.equal(MAX_ACCOUNT_LEVEL, 100);
  assert.equal(EXPERIENCE_REQUIRED_FOR_MAX_LEVEL, 500_000);
  assert.equal(experienceRequiredForLevel(MAX_ACCOUNT_LEVEL), 500_000);
});

test('each level requires more experience than the previous level', () => {
  let previousLevelCost = 0;

  for (let level = 1; level < MAX_ACCOUNT_LEVEL; level += 1) {
    const levelCost = experienceRequiredForLevel(level + 1) - experienceRequiredForLevel(level);
    assert.ok(levelCost > previousLevelCost, `Lv.${level} cost must increase`);
    previousLevelCost = levelCost;
  }
});

test('experience continues accumulating after reaching the maximum level', () => {
  const overflowExperience = 1_000_000;
  const progress = getExperienceProgress(overflowExperience);

  assert.equal(progress.level, MAX_ACCOUNT_LEVEL);
  assert.equal(progress.experience, overflowExperience);
  assert.equal(progress.experienceIntoLevel, 500_000);
  assert.equal(progress.nextLevelExperience, null);
  assert.equal(progress.experienceForNextLevel, null);
  assert.equal(progress.experienceToNextLevel, null);
  assert.equal(progress.progress, 1);
});
