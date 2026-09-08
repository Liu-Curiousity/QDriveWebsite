import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const authScriptPath = new URL('../src/scripts/auth-control.ts', import.meta.url);
const authComponentPath = new URL('../src/components/AuthControl.astro', import.meta.url);

test('authentication recovery refreshes tokens without treating expiry as logout', async () => {
  const source = await readFile(authScriptPath, 'utf8');
  const readState = source.match(/const readLoginState[\s\S]*?\n};/)?.[0] ?? '';

  assert.match(source, /\/oidc\/token/);
  assert.match(source, /grant_type:\s*'refresh_token'/);
  assert.match(source, /openid profile email offline_access/g);
  assert.match(source, /ensureFreshLoginState\(loginState\)/);
  assert.doesNotMatch(readState, /expireAt\s*<=\s*Date\.now\(\)/);
});

test('temporary profile failures preserve the last verified session', async () => {
  const source = await readFile(authScriptPath, 'utf8');

  assert.match(source, /profileSnapshot\?: AuthingProfile/);
  assert.match(source, /if \(error instanceof AuthSessionError && error\.invalidCredentials\)/);
  assert.match(source, /if \(loginState\.profileSnapshot\)\s*\{\s*setAuthenticated/);
  assert.match(source, /latest\?\.accessToken === failedState\.accessToken/);
});

test('the verified account snapshot is restored before first paint', async () => {
  const component = await readFile(authComponentPath, 'utf8');
  const bootstrapIndex = component.indexOf('const script = document.currentScript');
  const menuIndex = component.indexOf('class="auth-account-menu"');

  assert.ok(bootstrapIndex > 0 && bootstrapIndex < menuIndex);
  assert.match(component, /state\?\.profileSnapshot/);
  assert.match(component, /root\.dataset\.authState = 'restoring'/);
  assert.match(component, /label\.textContent = displayName/);
});

test('refresh recovery never paints the raw Authing email over the user ID', async () => {
  const source = await readFile(authScriptPath, 'utf8');
  const recovery = source.match(/void \(async \(\) => \{[\s\S]*?document\.addEventListener\('visibilitychange'/)?.[0] ?? '';

  assert.match(recovery, /withVerifiedPresentation\(profile, loginState\.profileSnapshot\)/);
  assert.match(recovery, /mergeSiteAccount\(loginState, recoveryProfile\)/);
  assert.doesNotMatch(recovery, /setAuthenticated\(profile\)/);
});
