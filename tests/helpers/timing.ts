/**
 * Wall-clock budgets in unit tests are scaled by this factor when coverage instrumentation is on (it makes hot loops
 * several times slower); `npm run test:perf` holds the strict performance budgets.
 */
export const TIME_SLACK = process.env.BUNK_COVERAGE === '1' ? 5 : 1;
