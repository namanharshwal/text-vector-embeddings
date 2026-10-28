import { describe, expect, it, mock } from "bun:test";
import { shouldRedactPrivateRepoComments } from "../src/utils/privacy";
import { addComments } from "../src/handlers/add-comments";
import { addIssue } from "../src/handlers/add-issue";
import { Context } from "../src/types/index";

describe("Privacy utility tests", () => {
  it("should return false when repository is public regardless of configuration", () => {
    expect(shouldRedactPrivateRepoComments(false, false)).toBe(false);
    expect(shouldRedactPrivateRepoComments(false, true)).toBe(false);
    expect(shouldRedactPrivateRepoComments(false, undefined)).toBe(false);
  });

  it("should return false when repository is private and redactPrivateRepoComments is false or undefined (default: capture everything)", () => {
    expect(shouldRedactPrivateRepoComments(true, false)).toBe(false);
    expect(shouldRedactPrivateRepoComments(true, undefined)).toBe(false);
  });

  it("should return true only when repository is private AND redactPrivateRepoComments is true", () => {
    expect(shouldRedactPrivateRepoComments(true, true)).toBe(true);
  });
});

describe("Comment and Issue handler redaction behavior", () => {
  function createMockContext(isPrivate: boolean, redactConfig: boolean | undefined) {
    const createCommentMock = mock(async () => {});
    const createIssueMock = mock(async () => {});
    const getIssueMock = mock(async () => [{ id: "issue_node_1" }]);

    const context = {
      logger: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
        ok: mock(),
      },
      env: {},
      config: {
        dedupeMatchThreshold: 0.95,
        dedupeWarningThreshold: 0.75,
        annotateThreshold: 0.65,
        jobMatchingThreshold: 0.75,
        demoFlag: false,
        redactPrivateRepoComments: redactConfig ?? false,
      },
      adapters: {
        supabase: {
          comment: {
            createComment: createCommentMock,
          },
          issue: {
            createIssue: createIssueMock,
            getIssue: getIssueMock,
          },
        },
        issueStore: {
          addIssue: mock(),
          setIssue: mock(),
          removeIssue: mock(),
        },
      },
      payload: {
        repository: {
          name: "test-repo",
          owner: { login: "ubiquity" },
          private: isPrivate,
        },
        issue: {
          node_id: "issue_node_1",
          number: 1,
          title: "Test Issue Title",
          body: "Test Issue Body",
          html_url: "https://github.com/ubiquity/test-repo/issues/1",
          user: { id: 100, login: "alice", type: "User" },
        },
        comment: {
          node_id: "comment_node_1",
          id: 101,
          body: "Test Comment Body",
          html_url: "https://github.com/ubiquity/test-repo/issues/1#issuecomment-101",
          user: { id: 100, login: "alice", type: "User" },
        },
      },
    } as unknown as Context<"issue_comment.created">;

    return { context, createCommentMock, createIssueMock };
  }

  it("should redact comments when repository is private and redactPrivateRepoComments is true", async () => {
    const { context, createCommentMock } = createMockContext(true, true);
    await addComments(context);

    expect(createCommentMock).toHaveBeenCalledTimes(1);
    const [commentData] = createCommentMock.mock.calls[0] as unknown as [{ isPrivate: boolean }];
    expect(commentData.isPrivate).toBe(true);
  });

  it("should NOT redact comments when repository is private and redactPrivateRepoComments is false (default)", async () => {
    const { context, createCommentMock } = createMockContext(true, false);
    await addComments(context);

    expect(createCommentMock).toHaveBeenCalledTimes(1);
    const [commentData] = createCommentMock.mock.calls[0] as unknown as [{ isPrivate: boolean }];
    expect(commentData.isPrivate).toBe(false);
  });

  it("should NOT redact comments when repository is public even if redactPrivateRepoComments is true", async () => {
    const { context, createCommentMock } = createMockContext(false, true);
    await addComments(context);

    expect(createCommentMock).toHaveBeenCalledTimes(1);
    const [commentData] = createCommentMock.mock.calls[0] as unknown as [{ isPrivate: boolean }];
    expect(commentData.isPrivate).toBe(false);
  });

  it("should redact issues when repository is private and redactPrivateRepoComments is true", async () => {
    const { context, createIssueMock } = createMockContext(true, true);
    await addIssue(context as unknown as Context<"issues.opened">);

    expect(createIssueMock).toHaveBeenCalledTimes(1);
    const [issueData] = createIssueMock.mock.calls[0] as unknown as [{ isPrivate: boolean }];
    expect(issueData.isPrivate).toBe(true);
  });

  it("should NOT redact issues when repository is private and redactPrivateRepoComments is false", async () => {
    const { context, createIssueMock } = createMockContext(true, false);
    await addIssue(context as unknown as Context<"issues.opened">);

    expect(createIssueMock).toHaveBeenCalledTimes(1);
    const [issueData] = createIssueMock.mock.calls[0] as unknown as [{ isPrivate: boolean }];
    expect(issueData.isPrivate).toBe(false);
  });
});
