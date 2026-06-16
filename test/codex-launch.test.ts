import {
  createBuiltinLaunchProfiles,
  createDefaultLaunchProfile,
  findLaunchProfile,
  formatLaunchProfileBehavior,
  formatLaunchProfileLabel,
  isUnsafeLaunchProfile,
  parseLaunchProfilesJson,
} from "../src/codex-launch.js";

describe("codex-launch", () => {
  it("parses valid launch profiles", () => {
    const profiles = parseLaunchProfilesJson(
      JSON.stringify([
        {
          id: "readonly",
          label: "Read Only",
          sandboxMode: "read-only",
          approvalPolicy: "never",
        },
        {
          id: "danger-full",
          label: "Danger Full",
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
        },
      ]),
    );

    expect(profiles).toEqual([
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        unsafe: true,
      },
    ]);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseLaunchProfilesJson("{")).toThrow("Invalid CODEX_LAUNCH_PROFILES_JSON");
  });

  it("rejects non-array values", () => {
    expect(() => parseLaunchProfilesJson("{}")).toThrow("expected a JSON array");
  });

  it("rejects invalid ids", () => {
    expect(() =>
      parseLaunchProfilesJson(
        JSON.stringify([
          {
            id: "Bad Id",
            label: "Bad",
            sandboxMode: "read-only",
            approvalPolicy: "never",
          },
        ]),
      ),
    ).toThrow("id must match");
  });

  it("rejects unsupported sandbox modes", () => {
    expect(() =>
      parseLaunchProfilesJson(
        JSON.stringify([
          {
            id: "bad",
            label: "Bad",
            sandboxMode: "unsafe",
            approvalPolicy: "never",
          },
        ]),
      ),
    ).toThrow('unsupported sandboxMode "unsafe"');
  });

  it("rejects unsupported approval policies", () => {
    expect(() =>
      parseLaunchProfilesJson(
        JSON.stringify([
          {
            id: "bad",
            label: "Bad",
            sandboxMode: "read-only",
            approvalPolicy: "sometimes",
          },
        ]),
      ),
    ).toThrow('unsupported approvalPolicy "sometimes"');
  });

  it("parses and validates optional safety policies", () => {
    expect(
      parseLaunchProfilesJson(
        JSON.stringify([
          {
            id: "restrict",
            label: "Restrict",
            sandboxMode: "danger-full-access",
            approvalPolicy: "never",
            safetyPolicy: "restrict",
          },
        ]),
      )[0],
    ).toMatchObject({ safetyPolicy: "restrict" });

    expect(() =>
      parseLaunchProfilesJson(
        JSON.stringify([
          {
            id: "bad",
            label: "Bad",
            sandboxMode: "danger-full-access",
            approvalPolicy: "never",
            safetyPolicy: "maybe",
          },
        ]),
      ),
    ).toThrow('unsupported safetyPolicy "maybe"');
  });

  it("formats profile labels and behavior", () => {
    const profile = createDefaultLaunchProfile("workspace-write", "never");

    expect(formatLaunchProfileBehavior(profile)).toBe("workspace-write / never");
    expect(formatLaunchProfileLabel(profile, true)).toContain("Default");
    expect(formatLaunchProfileLabel(profile, true)).toContain("✓");
  });

  it("always exposes read-only and review presets, plus optional full access", () => {
    expect(createBuiltinLaunchProfiles(createDefaultLaunchProfile("workspace-write", "never"))).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
    ]);

    expect(
      createBuiltinLaunchProfiles(createDefaultLaunchProfile("workspace-write", "never"), {
        includeFullAccess: true,
      }),
    ).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
      {
        id: "restrict",
        label: "Restrict",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        unsafe: true,
        safetyPolicy: "restrict",
      },
      {
        id: "full",
        label: "Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        unsafe: true,
        safetyPolicy: "full",
      },
    ]);
  });

  it("classifies danger-full-access as unsafe", () => {
    expect(isUnsafeLaunchProfile("danger-full-access")).toBe(true);
    expect(isUnsafeLaunchProfile("workspace-write")).toBe(false);
  });

  it("treats legacy full-access id as an alias for full when no exact match exists", () => {
    const profiles = createBuiltinLaunchProfiles(createDefaultLaunchProfile("workspace-write", "never"), {
      includeFullAccess: true,
    });

    expect(findLaunchProfile(profiles, "full-access")?.id).toBe("full");
    expect(findLaunchProfile([{ ...profiles.at(-1)!, id: "full-access" }], "full-access")?.id).toBe("full-access");
  });
});
