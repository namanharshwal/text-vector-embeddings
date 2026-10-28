import { describe, expect, it } from "bun:test";
import { parseIssueCommentIdFromUrl } from "../src/handlers/user-annotate";

describe("user annotate helpers", () => {
  it("extracts comment ids from GitHub URLs with query strings", () => {
    expect(parseIssueCommentIdFromUrl("https://github.com/owner/repo/issues/123?notification_referrer_id=abc#issuecomment-456")).toBe("456");
    expect(parseIssueCommentIdFromUrl("https://github.com/owner/repo/issues/123#issuecomment-456?notification_referrer_id=abc")).toBe("456");
  });

  it("returns null for URLs without an issue comment fragment", () => {
    expect(parseIssueCommentIdFromUrl("https://github.com/owner/repo/issues/123")).toBeNull();
  });
});
