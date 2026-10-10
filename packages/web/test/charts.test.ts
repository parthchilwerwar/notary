import { describe, it, expect } from "vitest";
import { resample } from "../src/components/dither-kit/dither-paint";
describe("recorded step trends", () => {
  it("holds an observed value until the next recorded point", () => {
    expect(resample([9, 0], 5, true)).toEqual([9, 9, 9, 9, 0]);
  });
  it("keeps the ordinary area resampling behavior separate", () => {
    expect(resample([9, 0], 3)).toEqual([9, 4.5, 0]);
  });
});
