import type { Page } from '@playwright/test';
import { expect, openTitle, test } from './fixtures';

const PW = 'correct horse battery';

const sessionToken = (page: Page) => page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('bunkcraft.profile.'))?.[1] ?? '');

/** The profile (id, xp) the server holds for the token this browser keeps. */
async function serverProfile(page: Page): Promise<{ id: string; xp: number; name: string }> {
  const token = await sessionToken(page);
  return page.evaluate(async (tk) => {
    const res = await fetch('/api/profile', { headers: { authorization: `Bearer ${tk}` } });
    return (await res.json()).profile;
  }, token);
}

test('accounts: a guest makes an account, another browser logs in to the same profile, wrong passwords read the same', async ({ page, browser, consoleErrors }) => {
  await openTitle(page);
  const banner = page.locator('.home-profile');
  await banner.click();
  await page.locator('input.mc-input:visible').first().fill('acct_guest');
  await page.keyboard.press('Enter');
  await expect(banner).toContainText(/Level 1/i);
  await expect(page.locator('.home-account')).toContainText('Guest');
  expect(await sessionToken(page)).toMatch(/^v1\./);
  const guest = await serverProfile(page);

  // Register: the guest profile becomes the account's profile and the browser gets a session token.
  await page.locator('.home-account').getByRole('button', { name: 'Create account' }).click();
  const inputs = page.locator('input.mc-input:visible');
  await inputs.nth(0).fill('Acct_User');
  await inputs.nth(1).fill('password123');
  await inputs.nth(2).fill('password123');
  await page.locator('.screen-footer').getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('.error:visible')).toContainText('too common');
  await inputs.nth(1).fill(PW);
  await inputs.nth(2).fill(PW);
  await page.locator('.screen-footer').getByRole('button', { name: 'Create account' }).click();
  const code = page.locator('.acct-code');
  await expect(code).toBeVisible();
  expect(((await code.textContent()) ?? '').trim()).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
  await page.getByRole('button', { name: 'I have saved it' }).click();
  await expect(page.locator('.home-account')).toContainText('Account: Acct_User');
  expect(await sessionToken(page)).toMatch(/^s1\./);
  expect((await serverProfile(page)).id).toBe(guest.id);

  // A second browser (another device): log in and see the same profile.
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await openTitle(page2);
  await page2.locator('.home-account').getByRole('button', { name: 'Log in' }).click();
  const in2 = page2.locator('input.mc-input:visible');
  await in2.nth(0).fill('acct_user');
  await in2.nth(1).fill('not the password');
  await page2.locator('.screen-footer').getByRole('button', { name: 'Log in' }).click();
  const wrong = await page2.locator('.error:visible').textContent();
  expect(wrong).toContain('Wrong username, password or code');
  await in2.nth(0).fill('Nobody_Here');
  await page2.locator('.screen-footer').getByRole('button', { name: 'Log in' }).click();
  await expect(page2.locator('.error:visible')).toHaveText(wrong ?? '');
  await in2.nth(0).fill('acct_user');
  await in2.nth(1).fill(PW);
  await page2.locator('.screen-footer').getByRole('button', { name: 'Log in' }).click();
  await expect(page2.locator('.home-account')).toContainText('Account: Acct_User');
  await expect(page2.locator('.home-profile')).toContainText(/Level 1/i);
  const same = await serverProfile(page2);
  expect(same.id).toBe(guest.id);
  expect(same.xp).toBe(guest.xp);

  // Log out: the session is dead on the server, the browser is a guest again.
  const dead = await sessionToken(page2);
  await page2.locator('.home-account').getByRole('button', { name: 'Account' }).click();
  await page2.getByRole('button', { name: 'Log out' }).click();
  await expect(page2.locator('.home-account')).toContainText('Guest');
  const status = await page2.evaluate(async (tk) => (await fetch('/api/account/me', { headers: { authorization: `Bearer ${tk}` } })).status, dead);
  expect(status).toBe(401);
  await other.close();
  // The refused calls above (weak password, wrong password) are logged by the browser as failed requests: expected here.
  consoleErrors.splice(0).filter((e) => !/status of 4(00|01|29)/.test(e)).forEach((e) => { throw new Error(e); });
});
