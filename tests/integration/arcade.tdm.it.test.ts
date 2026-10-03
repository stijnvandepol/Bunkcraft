import { afterAll, beforeAll, describe, it } from 'vitest';
import { playArcadeMatch } from './arcadeFlow';
import { type TestServer, startServer } from './harness';

let srv: TestServer;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.dispose(); });

describe('arcade tdm over real WebSockets', () => {
  it('plays warm-up, live, five headshot kills with respawns, and ends the match', async () => {
    const { shooter, victim } = await playArcadeMatch(srv, 'tdm');
    shooter.close();
    victim.close();
  }, 150_000); // honest walking (validated by the server) at running pace takes a while
});
