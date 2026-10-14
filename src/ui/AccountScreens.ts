import { levelFromXp } from '../modes/progression/Levels';
import { AccountError, changePassword, deleteAccount, login, logout, newRecoveryCode, recover, register } from '../net/AccountApi';
import { currentProfile } from '../net/ProfileApi';
import { button, h, menuScreen } from './dom';
import { type I18nKey, t } from './i18n';
import { savePlayerName } from './playerName';
import type { ScreenStack } from './Screens';

const COLUMN = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 4);';
const KNOWN = new Set(['network', 'invalid_request', 'username_format', 'username_reserved', 'password_short', 'password_long', 'password_common', 'password_name',
  'name_taken', 'invalid_credentials', 'locked', 'limited', 'full', 'unauthorized', 'already_account', 'account_locked', 'origin', 'disk']);

/** The player-facing text of a failed account call. Wrong password, unknown name and wrong code all read the same on purpose. */
export function accountErrorText(e: unknown, passwordOnly = false): string {
  const code = e instanceof AccountError ? e.code : 'network';
  // Where only a password is asked (change, delete, new code), "wrong username" would be odd.
  if (passwordOnly && code === 'invalid_credentials') return t('acct.err.password_wrong');
  const key = (KNOWN.has(code) ? `acct.err.${code}` : 'acct.err.invalid_request') as I18nKey;
  return code === 'locked' && e instanceof AccountError ? t(key, Math.max(1, e.retryAfter)) : t(key);
}

/**
 * Focuses the first field of a freshly opened dialog, once it is in the DOM. Never takes the focus from an input the
 * player (or an autofill) already moved to: a late focus() would otherwise swallow what is typed into the next field.
 */
function focusFirst(input: HTMLInputElement): void {
  window.setTimeout(() => {
    // A button (the one that opened the dialog) or nothing has focus: take it. A field that already has it keeps it.
    if (!(document.activeElement instanceof HTMLInputElement)) input.focus();
  }, 0);
}

function screen(title: string, body: (Node | null)[], footer: (Node | null)[]): HTMLDivElement {
  return menuScreen(title, body, footer, { cls: 'bc' });
}

/**
 * Account dialogs of the shooter home: create, log in, reset the password with the recovery code, and the
 * account screen (change password, new recovery code, log out, delete). `changed` runs after every change of
 * who this browser is, so the home screen and the profile reload.
 */
export class AccountScreens {
  constructor(private readonly stack: ScreenStack, private readonly changed: () => void) {}

  private field(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
    return h('div', { class: 'acct-field', style: 'display: flex; flex-direction: column; gap: calc(var(--u) * 1.5); width: 100%; max-width: max(calc(var(--u) * 110), min(100%, 360px));' },
      h('div', { class: 'field-label', text: label }), input, hint ? h('div', { class: 'hint', text: hint }) : null);
  }

  private text(autocomplete: string, max = 16): HTMLInputElement {
    return h('input', { class: 'mc-input', type: 'text', maxLength: max, autocomplete, spellcheck: false, autocapitalize: 'off' });
  }

  private secret(autocomplete: 'current-password' | 'new-password'): HTMLInputElement {
    return h('input', { class: 'mc-input', type: 'password', maxLength: 64, autocomplete });
  }

  /** Runs `action` with the screen locked, shows its error, and calls `ok` when it succeeds. */
  private submit(error: HTMLElement, buttons: HTMLButtonElement[], action: () => Promise<void>, passwordOnly = false): void {
    error.textContent = '';
    for (const b of buttons) b.disabled = true;
    const busy = t('acct.working');
    const label = buttons[0]?.textContent ?? '';
    if (buttons[0]) buttons[0].textContent = busy;
    action().catch((e: unknown) => { error.textContent = accountErrorText(e, passwordOnly); }).finally(() => {
      for (const b of buttons) b.disabled = false;
      if (buttons[0]) buttons[0].textContent = label;
    });
  }

  private onEnter(inputs: HTMLInputElement[], go: () => void): void {
    for (const i of inputs) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  showRegister(): void {
    const name = this.text('username');
    const pw = this.secret('new-password');
    const pw2 = this.secret('new-password');
    const error = h('div', { class: 'error' });
    const go = () => {
      if (pw.value !== pw2.value) { error.textContent = t('acct.mismatch'); return; }
      this.submit(error, [create], async () => {
        const r = await register(name.value.trim(), pw.value);
        savePlayerName(r.name);
        this.stack.pop();
        this.showRecoveryCode(r.recovery ?? '', () => this.changed());
      });
    };
    const create = button(t('acct.submitRegister'), go, { cls: 'w150 primary' });
    this.onEnter([name, pw, pw2], go);
    this.stack.push(screen(t('acct.registerTitle'), [
      h('div', { style: COLUMN },
        this.field(t('acct.username'), name, t('acct.usernameHint')),
        this.field(t('acct.password'), pw, t('acct.passwordHint')),
        this.field(t('acct.passwordRepeat'), pw2),
        h('div', { class: 'hint', text: t('acct.registerHint') }),
        error,
        button(t('acct.haveAccount'), () => { this.stack.pop(); this.showLogin(); }, { cls: 'w250' }),
      ),
    ], [
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
      create,
    ]));
    focusFirst(name);
  }

  showLogin(): void {
    const name = this.text('username');
    const pw = this.secret('current-password');
    const error = h('div', { class: 'error' });
    const attempt = async (discard: boolean) => {
      const r = await login(name.value.trim(), pw.value, discard);
      savePlayerName(r.name);
      this.stack.pop();
      this.changed();
    };
    const go = () => this.submit(error, [enter], async () => {
      try {
        await attempt(false);
      } catch (e) {
        // No silent merge: the guest progress of this browser is only dropped when the player says so.
        if (e instanceof AccountError && e.code === 'guest_progress') { this.confirmDiscard(e, () => this.submit(error, [enter], () => attempt(true))); return; }
        throw e;
      }
    });
    const enter = button(t('acct.submitLogin'), go, { cls: 'w150 primary' });
    this.onEnter([name, pw], go);
    this.stack.push(screen(t('acct.loginTitle'), [
      h('div', { style: COLUMN },
        this.field(t('acct.username'), name),
        this.field(t('acct.password'), pw),
        error,
        h('div', { style: 'display: flex; gap: calc(var(--u) * 3); flex-wrap: wrap; justify-content: center;' },
          button(t('acct.forgot'), () => { this.stack.pop(); this.showRecover(name.value.trim()); }, { cls: 'w200' }),
          button(t('acct.noAccount'), () => { this.stack.pop(); this.showRegister(); }, { cls: 'w250' })),
      ),
    ], [
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
      enter,
    ]));
    focusFirst(name);
  }

  private confirmDiscard(e: AccountError, discard: () => void): void {
    const level = levelFromXp(e.guest?.xp ?? currentProfile()?.xp ?? 0).level;
    this.stack.push(screen(t('acct.discardTitle'), [
      h('div', { style: COLUMN }, h('div', { class: 'hint', text: t('acct.discardText', level) })),
    ], [
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
      button(t('acct.discardYes'), () => { this.stack.pop(); discard(); }, { cls: 'w250 primary' }),
    ]));
  }

  showRecover(prefill = ''): void {
    const name = this.text('username');
    name.value = prefill;
    const code = h('input', { class: 'mc-input', type: 'text', maxLength: 40, autocomplete: 'off', spellcheck: false, autocapitalize: 'characters' });
    const pw = this.secret('new-password');
    const error = h('div', { class: 'error' });
    const go = () => this.submit(error, [reset], async () => {
      const r = await recover(name.value.trim(), code.value.trim(), pw.value);
      savePlayerName(r.name);
      this.stack.pop();
      this.showRecoveryCode(r.recovery ?? '', () => this.changed());
    });
    const reset = button(t('acct.recoverSubmit'), go, { cls: 'w200 primary' });
    this.onEnter([name, code, pw], go);
    this.stack.push(screen(t('acct.recoverTitle'), [
      h('div', { style: COLUMN },
        h('div', { class: 'hint', text: t('acct.recoverHint') }),
        this.field(t('acct.username'), name),
        this.field(t('acct.recoverCode'), code),
        this.field(t('acct.passwordNew'), pw, t('acct.passwordHint')),
        error,
      ),
    ], [
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
      reset,
    ]));
    focusFirst((prefill ? code : name));
  }

  /** The one-time recovery code. The only button that leaves the screen says the player saved it. */
  private showRecoveryCode(codeText: string, done: () => void): void {
    const copy = button(t('acct.recoveryCopy'), () => {
      void navigator.clipboard?.writeText(codeText).then(() => { copy.textContent = t('acct.recoveryCopied'); }).catch(() => undefined);
    }, { cls: 'w200' });
    this.stack.push(screen(t('acct.recoveryTitle'), [
      h('div', { style: COLUMN },
        h('div', { class: 'hint', text: t('acct.recoveryText') }),
        h('div', { class: 'acct-code', style: 'font-family: monospace; font-size: min(calc(var(--u) * 9), 4.2vw); letter-spacing: 0.08em; user-select: all; padding: calc(var(--u) * 4); overflow-wrap: anywhere;', text: codeText }),
        copy,
      ),
    ], [
      button(t('acct.recoverySaved'), () => { this.stack.pop(); done(); }, { cls: 'w250 primary' }),
    ]));
  }

  /** Logged in: change the password, a new recovery code, log out, delete. */
  showAccount(): void {
    const p = currentProfile();
    this.stack.push(screen(t('acct.manage'), [
      h('div', { style: COLUMN },
        h('div', { class: 'field-label', text: t('acct.signedIn', p?.name ?? '') }),
        button(t('acct.changePassword'), () => this.showChangePassword(), { cls: 'w250' }),
        button(t('acct.newRecovery'), () => this.confirmPassword(t('acct.newRecovery'), t('acct.recoveryText'), t('common.done'), async (pw) => {
          const code = await newRecoveryCode(pw);
          this.stack.pop();
          this.showRecoveryCode(code, () => undefined);
        }), { cls: 'w250' }),
        button(t('acct.logout'), () => { void logout().then(() => { this.stack.pop(); this.changed(); }); }, { cls: 'w250' }),
        button(t('acct.delete'), () => this.confirmPassword(t('acct.deleteTitle'), t('acct.deleteText'), t('acct.deleteYes'), async (pw) => {
          await deleteAccount(pw);
          this.stack.pop();
          this.stack.pop();
          this.changed();
        }), { cls: 'w250' }),
      ),
    ], [
      button(t('common.back'), () => this.stack.pop(), { cls: 'w150' }),
    ]));
  }

  private showChangePassword(): void {
    const old = this.secret('current-password');
    const next = this.secret('new-password');
    const next2 = this.secret('new-password');
    const error = h('div', { class: 'error' });
    const go = () => {
      if (next.value !== next2.value) { error.textContent = t('acct.mismatch'); return; }
      this.submit(error, [save], async () => {
        await changePassword(old.value, next.value);
        error.textContent = '';
        this.stack.pop();
      }, true);
    };
    const save = button(t('common.done'), go, { cls: 'w150 primary' });
    this.onEnter([old, next, next2], go);
    this.stack.push(screen(t('acct.changePassword'), [
      h('div', { style: COLUMN },
        this.field(t('acct.passwordOld'), old),
        this.field(t('acct.passwordNew'), next, t('acct.passwordHint')),
        this.field(t('acct.passwordRepeat'), next2),
        error,
      ),
    ], [button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }), save]));
    focusFirst(old);
  }

  /** A screen that wants the password again before a sensitive action. */
  private confirmPassword(title: string, text: string, label: string, action: (password: string) => Promise<void>): void {
    const pw = this.secret('current-password');
    const error = h('div', { class: 'error' });
    const go = () => this.submit(error, [ok], () => action(pw.value), true);
    const ok = button(label, go, { cls: 'w250 primary' });
    this.onEnter([pw], go);
    this.stack.push(screen(title, [
      h('div', { style: COLUMN }, h('div', { class: 'hint', text: text }), this.field(t('acct.password'), pw), error),
    ], [button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }), ok]));
    focusFirst(pw);
  }
}
