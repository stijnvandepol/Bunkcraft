/** Stack of full-screen menu panels; only the top one is visible. */
export class ScreenStack {
  private readonly stack: HTMLElement[] = [];

  constructor(readonly container: HTMLElement) {}

  push(el: HTMLElement): void {
    this.top?.classList.add('hidden');
    this.stack.push(el);
    this.container.append(el);
  }

  /** Replace the top screen (e.g. refresh a list). */
  replace(el: HTMLElement): void {
    this.stack.pop()?.remove();
    this.stack.push(el);
    this.container.append(el);
  }

  pop(): void {
    this.stack.pop()?.remove();
    this.top?.classList.remove('hidden');
  }

  clear(): void {
    while (this.stack.length) this.stack.pop()!.remove();
  }

  get top(): HTMLElement | undefined {
    return this.stack[this.stack.length - 1];
  }

  get depth(): number {
    return this.stack.length;
  }
}
