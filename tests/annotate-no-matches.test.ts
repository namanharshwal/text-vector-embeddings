import { afterEach, describe, expect, it, mock } from "bun:test";
import { Logs } from "@ubiquity-os/ubiquity-os-logger";
import {
  annotate,
  commentChecker,
  EMPTY_COMMENT_BODY_MESSAGE,
  NO_ANNOTATE_MATCHES_MESSAGE,
  NO_PREVIOUS_COMMENT_MESSAGE,
  postAnnotateResponse,
} from "../src/handlers/annotate";
import type { Context } from "../src/types/index";

function createMockContext(overrides?: {
  commentHandler?: Context["commentHandler"];
  createCommentMock?: ReturnType<typeof mock>;
  listCommentsMock?: ReturnType<typeof mock>;
  getCommentMock?: ReturnType<typeof mock>;
  updateCommentMock?: ReturnType<typeof mock>;
  findSimilarIssuesMock?: ReturnType<typeof mock>;
  findSimilarCommentsMock?: ReturnType<typeof mock>;
}) {
  const createComment = overrides?.createCommentMock ?? mock(async () => ({ data: { id: 101 } }));
  const listComments = overrides?.listCommentsMock ?? mock(async () => ({ data: [] }));
  const getComment = overrides?.getCommentMock ?? mock(async () => ({ data: { id: 1, body: "Target comment", node_id: "node_1" } }));
  const updateComment = overrides?.updateCommentMock ?? mock(async () => ({ data: { id: 1 } }));

  const findSimilarIssues = overrides?.findSimilarIssuesMock ?? mock(async () => []);
  const findSimilarComments = overrides?.findSimilarCommentsMock ?? mock(async () => []);

  const context = {
    eventName: "issue_comment.created",
    command: null,
    authToken: "mock-token",
    commentHandler: overrides?.commentHandler,
    payload: {
      action: "created",
      repository: {
        name: "test-repo",
        owner: {
          login: "test-org",
        },
      },
      issue: {
        number: 42,
      },
      comment: {
        id: 99,
        body: "/annotate",
        node_id: "cmd_node",
      },
    } as unknown as Context<"issue_comment.created">["payload"],
    config: {
      annotateThreshold: 0.7,
      dedupeWarningThreshold: 0.75,
      dedupeMatchThreshold: 0.95,
      jobMatchingThreshold: 0.95,
      demoFlag: false,
    } as Context["config"],
    logger: new Logs("debug") as unknown as Context["logger"],
    env: {
      DATABASE_URL: "postgres://db.example/text-vector-embeddings",
      EMBEDDINGS_QUEUE_ENABLED: "false",
    } as Context["env"],
    octokit: {
      rest: {
        issues: {
          createComment,
          listComments,
          getComment,
          updateComment,
        },
      },
      graphql: mock(async () => ({})),
    } as unknown as Context["octokit"],
    adapters: {
      supabase: {
        issue: {
          findSimilarIssues,
        },
        comment: {
          findSimilarComments,
        },
      },
    } as unknown as Context["adapters"],
  } as unknown as Context<"issue_comment.created">;

  return {
    context,
    createComment,
    listComments,
    getComment,
    updateComment,
    findSimilarIssues,
    findSimilarComments,
  };
}

describe("Annotate No Matches Feedback", () => {
  afterEach(() => {
    mock.restore();
  });

  describe("postAnnotateResponse", () => {
    it("posts via commentHandler.postComment when available", async () => {
      const postComment = mock(async () => ({ id: 123 }));
      const { context } = createMockContext({
        commentHandler: {
          postComment,
        } as unknown as Context["commentHandler"],
      });

      await postAnnotateResponse(context, NO_ANNOTATE_MATCHES_MESSAGE);

      expect(postComment).toHaveBeenCalledTimes(1);
      const call = postComment.mock.calls[0];
      expect(call[0]).toBe(context);
      expect(call[1]?.logMessage?.raw).toBe(NO_ANNOTATE_MATCHES_MESSAGE);
      expect(call[2]).toEqual({ raw: true, commentKind: "command-response" });
    });

    it("falls back to octokit.rest.issues.createComment when commentHandler is undefined", async () => {
      const { context, createComment } = createMockContext({
        commentHandler: undefined,
      });

      await postAnnotateResponse(context, NO_ANNOTATE_MATCHES_MESSAGE);

      expect(createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body: NO_ANNOTATE_MATCHES_MESSAGE,
      });
    });
  });

  describe("annotate and commentChecker", () => {
    it("posts a feedback message when no previous comments exist before /annotate", async () => {
      const listCommentsMock = mock(async () => ({
        data: [{ id: 99, body: "/annotate" }],
      }));
      const { context, createComment } = createMockContext({ listCommentsMock });

      await annotate(context, null, "org");

      expect(createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body: NO_PREVIOUS_COMMENT_MESSAGE,
      });
    });

    it("posts a feedback message when the targeted comment body is empty", async () => {
      const { context, createComment } = createMockContext();

      await commentChecker(context, { id: 1, body: "", node_id: "node_1" } as never, "org");

      expect(createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body: EMPTY_COMMENT_BODY_MESSAGE,
      });
    });

    it("posts a feedback message when no similar issues or comments match the threshold", async () => {
      const { context, createComment, updateComment } = createMockContext({
        findSimilarIssuesMock: mock(async () => []),
        findSimilarCommentsMock: mock(async () => []),
      });

      await commentChecker(context, { id: 1, body: "Some technical comment", node_id: "node_1" } as never, "org");

      expect(createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body: NO_ANNOTATE_MATCHES_MESSAGE,
      });
      expect(updateComment).not.toHaveBeenCalled();
    });
  });
});
