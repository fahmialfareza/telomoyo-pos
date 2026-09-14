import type { ConfigContext } from "expo/config";

import buildConfig from "../../app.config";

describe("Telomoyo POS application identity", () => {
  const config = buildConfig({
    config: { name: "legacy", slug: "legacy" },
  } as ConfigContext);

  it("uses the new public brand and release version", () => {
    expect(config.name).toBe("Telomoyo POS");
    expect(config.version).toBe(process.env.EXPO_APP_VERSION || "1.0.0");
    expect(config.android?.versionCode).toBe(
      parseInt(process.env.EXPO_APP_VERSION_CODE || "1", 10) || 1,
    );
    expect(config.ios?.buildNumber).toBe("2");
  });

  it("preserves identifiers required for an in-place upgrade", () => {
    expect(config.android?.package).toBe("com.fahmialfareza.sewamotorpos");
    expect(config.ios?.bundleIdentifier).toBe("com.fahmialfareza.sewamotorpos");
    expect(config.slug).toBe("telomoyo-pos");
    expect(config.scheme).toBe("sewamotor");
  });
});
