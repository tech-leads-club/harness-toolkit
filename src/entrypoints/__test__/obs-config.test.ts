import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { OBS_CONFIG_AUDIT, obsConfigFor } from "../support.ts";

const base = coreFacade.policy.DEFAULTS;

describe("obsConfigFor", () => {
  test("a project that configures nothing gets today's defaults", () => {
    const config = obsConfigFor(base);
    assert.equal(config.includePayloads, coreFacade.observability.DEFAULT_OBS.includePayloads);
    assert.equal(config.maxAttrChars, coreFacade.observability.DEFAULT_OBS.maxAttrChars);
    assert.equal(config.retentionDays, coreFacade.observability.DEFAULT_OBS.retentionDays);
    assert.equal(config.sessionCostAlertUsd, coreFacade.observability.DEFAULT_OBS.sessionCostAlertUsd);
    assert.equal(config.globalSpool, false);
  });

  // hazard: the dead "observability" config section advertised exactly these fields for months. Each one
  // has to reach the runtime now, or the config is lying again.
  test("every field a project may set reaches the resolved config", () => {
    const config = obsConfigFor({
      obs: {
        globalSpool: true,
        includePayloads: true,
        maxAttrChars: 42,
        sessionCostAlertUsd: 9,
        retentionDays: 3,
      },
    });
    assert.equal(config.globalSpool, true);
    assert.equal(config.includePayloads, true);
    assert.equal(config.maxAttrChars, 42);
    assert.equal(config.sessionCostAlertUsd, 9);
    assert.equal(config.retentionDays, 3);
  });

  test("the audit base keeps debug on even when the project leaves it off", () => {
    const config = obsConfigFor(base, OBS_CONFIG_AUDIT);
    assert.equal(config.debugEnabled, true);
  });

  test("a null cost alert is carried through rather than replaced by the default", () => {
    const config = obsConfigFor({ obs: { ...base.obs, sessionCostAlertUsd: null } });
    assert.equal(config.sessionCostAlertUsd, null);
  });
});
