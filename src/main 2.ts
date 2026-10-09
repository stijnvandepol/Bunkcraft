import * as THREE from 'three';
import { Game } from './core/Game';
import { initPwa } from './pwa/Pwa';
import './ui/styles.css';

// All colours in this project are authored and output in display (sRGB) space, like
// Minecraft's own lighting; disable three.js' automatic linear conversion.
THREE.ColorManagement.enabled = false;

// Early, so the browser's install prompt event is not missed.
initPwa();

const root = document.getElementById('app')!;

function fail(message: string): void {
  root.replaceChildren();
  const el = document.createElement('div');
  el.className = 'fatal';
  // The wordmark of the home screen (BUNK in white, CRAFT in the gradient) over the message.
  const mark = document.createElement('div');
  mark.className = 'home-wordmark';
  const craft = document.createElement('span');
  craft.className = 'craft';
  craft.textContent = 'CRAFT';
  mark.append('BUNK', craft);
  const text = document.createElement('div');
  text.className = 'fatal-text';
  text.textContent = message;
  el.append(mark, text);
  root.append(el);
}

if (!document.createElement('canvas').getContext('webgl2')) {
  fail('BunkCraft needs WebGL2. Please use a recent version of Chrome, Edge, Firefox or Safari.');
} else {
  try {
    const game = new Game(root);
    // Handle for automated testing in development builds only.
    if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
    game.start().catch((e: unknown) => {
      console.error(e);
      fail(`Failed to start: ${e instanceof Error ? e.message : String(e)}`);
    });
  } catch (e) {
    // E.g. WebGLRenderer creation failed (blocklisted GPU): show a message, not a blank page.
    console.error(e);
    fail(`Failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }
}
