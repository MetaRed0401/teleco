import { describe, expect, it } from "vitest";

import { renderLinuxBridgeUnit, renderLinuxRuntimeUnit } from "../src/linux-service.js";

describe("Linux service rendering", () => {
  it("uses stable CLI and per-instance configuration paths", () => {
    const unit = renderLinuxBridgeUnit(
      ["/home/linuxbrew/.linuxbrew/bin/teleco"],
      "/home/user/.config/teleco/instances",
    );
    expect(unit).toContain("EnvironmentFile=/home/user/.config/teleco/instances/%i.env");
    expect(unit).toContain('ExecStart="/home/linuxbrew/.linuxbrew/bin/teleco" run --instance %i');
    expect(unit).toContain("Wants=telecodex-codex-app-server.service");
  });

  it("keeps the persistent Codex runtime independent from bridge instances", () => {
    expect(renderLinuxRuntimeUnit(["/brew/bin/teleco"]))
      .toContain('ExecStart="/brew/bin/teleco" runtime');
  });
});
