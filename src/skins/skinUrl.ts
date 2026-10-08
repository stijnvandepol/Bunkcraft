/**
 * Where skin files come from: the page's own server (`/skins/<hash>.png`, served by server/App.ts with long cache
 * headers; the Vite dev server proxies it). Skins of other servers (Direct Connect) are not fetched cross-origin.
 */
export const skinUrl = (hash: string): string => `/skins/${hash}.png`;
