import assert from "node:assert/strict";
import { test } from "node:test";
import { route, UsageError } from "../../bin/tlc-cli.ts";

/**
 * What is left of this file after the shell installers were deleted.
 *
 * The three tests that drove `install.sh` — recovering a stuck managed checkout, the operator's state surviving a
 * hard reset, and refusing to run git against a linked clone — went with the script. The recovery route they
 * covered is now `npm i -g @tech-leads-club/harness-toolkit@latest` followed by `tlc harness install`, which
 * replaces the CLI before it is asked to fix itself and needs no git at all
 * ([/decisions/ad-097.md](/decisions/ad-097.md)).
 *
 * The refusal to write to a linked clone still has a test: `linkDir` refuses a destination it did not create, and
 * `runtimePathKind` keeps `update` off a contributor's checkout.
 */

/**
 * hazard: `update` accepted any flag in silence. An operator whose update had failed typed `--force`, got no
 * acknowledgement that it does not exist, and read the same failure as a refusal to force.
 */
test("update --force says what to do instead of being ignored", () => {
  assert.throws(() => route(["update", "--force"]), UsageError);
  assert.throws(() => route(["update", "--force"]), /takes no --force/);
  assert.throws(() => route(["update", "--force"]), /npm i -g @tech-leads-club\/harness-toolkit@latest/);
});

test("update rejects an unknown flag by name", () => {
  assert.throws(() => route(["update", "--wat"]), /unknown flag: --wat/);
});

test("update --check still routes, and a bare update still routes", () => {
  assert.equal(route(["update", "--check"]).kind, "update-check");
  assert.equal(route(["update"]).kind, "update");
});
