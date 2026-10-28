import { describe, expect, it } from "bun:test";
import { pluginSettingsSchema } from "../src/types/plugin-input";

describe("plugin settings schema", () => {
  it("describes alwaysRecommend as a contributor count override", () => {
    expect(pluginSettingsSchema.properties.alwaysRecommend.description).toBe(
      "This amount of contributors will always be recommended regardless of the similarity score."
    );
  });
});
