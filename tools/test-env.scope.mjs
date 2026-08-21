/**
 * Set some environment variables for the duration of a call, then put them back exactly as they were.
 *
 * hazard: this existed three times before an independent review counted them — `withEnv` in
 * `platform/__test__/config-dirs.test.ts`, `withLauncherEnv` in `tools/__test__/install-runtime.test.ts`, and
 * `withHome` in `core/floor/__test__/floor.test.ts`. Each was written for one caller and each got the
 * save-and-restore right in its own way, which is three chances to get it wrong
 * ([/decisions/ad-102.md](/decisions/ad-102.md)).
 *
 * why `undefined` deletes rather than assigns: `process.env.X = undefined` stores the *string* `"undefined"`, which
 * is the bug this signature exists to make unavailable.
 *
 * invariant: restored in `finally`, so a throwing test cannot leave the next one reading a value it did not set —
 * the whole suite shares one process.
 */
export function withEnv(values, run) {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
