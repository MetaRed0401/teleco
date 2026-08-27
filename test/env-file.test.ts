import { describe, expect, it } from "vitest";

import { parseEnvironmentText, serializeEnvironment } from "../src/env-file.js";

describe("environment files", () => {
  it("parses comments, exports, quotes, and embedded equals signs", () => {
    expect(parseEnvironmentText('# comment\nexport A=one\nB="two words"\nTOKEN=1:a=b\n')).toEqual({
      A: "one",
      B: "two words",
      TOKEN: "1:a=b",
    });
  });

  it("round trips values that require quoting", () => {
    const values = { A: "one", B: "two words", C: "line\nnext" };
    expect(parseEnvironmentText(serializeEnvironment(values))).toEqual(values);
  });
});
