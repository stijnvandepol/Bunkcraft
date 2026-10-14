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

test('accounts: a guest with progress is asked before logging in; cancel stays a guest, accept logs in to the account profile', async ({ page, browser, consoleErrors }) => {
  // The account (made through the API, as another device would).
  const other = await browser.newContext();
  const p0 = await other.newPage();
  await openTitle(p0);
  const made = await p0.evaluate(async (pw) => (await fetch('/api/account/register', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ask_User', password: pw }),
  })).json(), PW);
  const accountProfile = (made.profile as { id: string }).id;
  await other.close();

  await openTitle(page);
  await page.locator('.home-profile').click();
  await page.locator('input.mc-input:visible').first().fill('ask_guest');
  await page.keyboard.press('Enter');
  await expect(page.locator('.home-account')).toContainText('Guest');
  await expect.poll(() => sessionToken(page)).toMatch(/^v1\./);
  const guestToken = await sessionToken(page);
  const guest = await serverProfile(page);

  // A guest cannot earn XP in a browser test, so the first login call is answered with the 409 (guest_progress) the
  // server sends for a guest with XP (tests/accountsServer.test.ts covers the real server); the second one goes through.
  let sawDiscard = 0;
  await page.route('**/api/account/login', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { discardGuest?: boolean };
    if (body.discardGuest) { sawDiscard++; return route.continue(); }
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'guest_progress', guest: { name: 'ask_guest', xp: 800, prestige: 0 } }) });
  });
  const login = async () => {
    await page.locator('.home-account').getByRole('button', { name: 'Log in' }).click();
    const inputs = page.locator('input.mc-input:visible');
    await inputs.nth(0).fill('ask_user');
    await inputs.nth(1).fill(PW);
    await page.locator('.screen-footer').getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByText('Discard guest progress?')).toBeVisible();
  };

  // Cancel: back at the login form, still a guest, the guest token and profile untouched.
  await login();
  await page.locator('.screen-footer').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.screen-footer').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.home-account')).toContainText('Guest');
  expect(await sessionToken(page)).toBe(guestToken);
  expect((await serverProfile(page)).id).toBe(guest.id);
  expect(sawDiscard).toBe(0);

  // Accept: logged in with the account profile.
  await login();
  await page.getByRole('button', { name: 'Discard and log in' }).click();
  await expect(page.locator('.home-account')).toContainText('Account: Ask_User');
  expect(sawDiscard).toBe(1);
  expect(await sessionToken(page)).toMatch(/^s1\./);
  expect((await serverProfile(page)).id).toBe(accountProfile);
  // The two 409 answers are logged by the browser as failed requests: expected here.
  consoleErrors.splice(0).filter((e) => !/status of 409/.test(e)).forEach((e) => { throw new Error(e); });
});
