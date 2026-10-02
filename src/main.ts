import * as THREE from 'three';
import { Game } from './core/Game';
import './ui/styles.css';

// All colours in this project are authored and output in display (sRGB) space, like
// Minecraft's own lighting; disable three.js' automatic linear conversion.
THREE.ColorManagement.enabled = false;

const root = document.getElementById('app')!;

function fail(message: string): void {
  root.replaceChildren();
  const el = document.createElement('div');
  el.className = 'fatal';
  el.textContent = message;
  root.append(el);
}

if (!document.createElement('canvas').getContext('webgl2')) {
  fail('BunkCraft needs WebGL2. Please use a recent version of Chrome, Edge, Firefox or Safari.');
} else {
  const game = new Game(root);
  // Handle for automated testing in development builds only.
  if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
  game.start().catch((e: unknown) => {
    console.error(e);
    fail(`Failed to start: ${e instanceof Error ? e.message : String(e)}`);
  });
}
