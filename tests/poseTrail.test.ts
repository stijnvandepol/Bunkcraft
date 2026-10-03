/**
 * QA: a friend walking at a steady pace stuttered (snapshot steps 0 / 0.22 / 0.44 blocks) because the server put the
 * newest position report in each tick while reports and ticks are out of phase. PoseTrail samples one fixed moment.
 */
import { describe, expect, it } from 'vitest';
import { POSE_SAMPLE_DELAY_MS, type Pose, PoseTrail } from '../server/PoseTrail';

const SPEED = 4.317 / 1000; // blocks per ms

describe('PoseTrail', () => {
  it('turns out-of-phase reports into even snapshot steps', () => {
    const trail = new PoseTrail();
    const pose: Pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    // Reports every 50 ms with up to ±12 ms of jitter, ticks every 50 ms at another phase.
    const jitter = [0, 11, -9, 12, -12, 3, 8, -5, 10, -11];
    const reports: number[] = [];
    for (let i = 0; i < 40; i++) reports.push(1000 + i * 50 + 2 + jitter[i % jitter.length]);
    let r = 0;
    const newest: number[] = [], sampled: number[] = [];
    let lastX = 0;
    for (let tick = 1200; tick < 2800; tick += 50) {
      while (r < reports.length && reports[r] <= tick) {
        // Position as of the send; the receive time is what the trail knows.
        lastX = (reports[r] - 1000) * SPEED;
        trail.push(reports[r], lastX, 64, 0, 0, 0);
        r++;
      }
      newest.push(lastX);
      trail.sample(tick - POSE_SAMPLE_DELAY_MS, pose);
      sampled.push(pose.x);
    }
    const steps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]);
    const expected = 50 * SPEED;
    const worst = (xs: number[]) => Math.max(...steps(xs).map((s) => Math.abs(s - expected)));
    // The old way: some ticks see no new report, others two.
    expect(worst(newest)).toBeGreaterThan(expected * 0.5);
    // Sampling the trail: every step within the report jitter of the true step.
    expect(worst(sampled)).toBeLessThan(expected * 0.5);
  });

  it('holds the newest report when nothing newer arrived, and jumps across a teleport', () => {
    const trail = new PoseTrail();
    const pose: Pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    expect(trail.sample(0, pose)).toBe(false);
    trail.push(100, 1, 64, 1, 0, 0);
    trail.push(150, 2, 64, 1, 0, 0);
    trail.sample(500, pose);
    expect(pose.x).toBe(2);
    trail.sample(125, pose);
    expect(pose.x).toBeCloseTo(1.5);
    trail.push(200, 500, 64, 1, 0, 0);
    trail.sample(175, pose);
    expect(pose.x).toBe(500);
    trail.reset();
    expect(trail.sample(175, pose)).toBe(false);
  });

  it('interpolates yaw the short way round', () => {
    const trail = new PoseTrail();
    const pose: Pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    trail.push(0, 0, 0, 0, Math.PI - 0.1, 0);
    trail.push(100, 0, 0, 0, -Math.PI + 0.1, 0);
    trail.sample(50, pose);
    expect(Math.abs(Math.abs(pose.yaw) - Math.PI)).toBeLessThan(1e-9);
  });
});
