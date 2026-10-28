import { describe, expect, it, mock } from "bun:test";
import { Logs } from "@ubiquity-os/ubiquity-os-logger";
import { issueMatchingWithComment } from "../src/handlers/issue-matching";
import { runPlugin } from "../src/plugin";
import type { Context } from "../src/types/index";

const TEST_REPO_NAME = "test-repo";
const TEST_OWNER_LOGIN = "ubiquity";
const TEST_AUTHOR_LOGIN = "author";
const TEST_TASK_TITLE = "Task Title";
const TEST_TASK_DESCRIPTION = "Task description";
const TEST_TIMESTAMP = "2025-07-23T08:43:10Z";
const TEST_ISSUE_URL = "https://github.com/ubiquity/test-repo/issues/1";
const TEST_ISSUE_NODE_ID = "ISSUE_1";

describe("issue matching and deduplication (#108)", () => {
  it("cleans up existing duplicate recommendation comments by updating the first and deleting extras", async () => {
    const updatedComments: Array<{ comment_id: number; body: string }> = [];
    const deletedComments: Array<{ comment_id: number }> = [];
    const createdComments: Array<{ issue_number: number; body: string }> = [];

    const mockOctokit = {
      paginate: mock(async () => [
        { id: 101, body: ">[!NOTE]\n>The following contributors may be suitable for this task:\n### [userA](urlA)" },
        { id: 102, body: ">[!NOTE]\n>The following contributors may be suitable for this task:\n### [userB](urlB)" },
      ]),
      rest: {
        issues: {
          listComments: mock(),
          updateComment: mock(async (params: { comment_id: number; body: string }) => {
            updatedComments.push(params);
          }),
          deleteComment: mock(async (params: { comment_id: number }) => {
            deletedComments.push(params);
          }),
          createComment: mock(async (params: { issue_number: number; body: string }) => {
            createdComments.push(params);
          }),
        },
      },
      graphql: mock(async () => ({
        node: {
          title: "Similar Issue",
          url: "https://github.com/ubiquity/test-repo/issues/10",
          state: "CLOSED",
          stateReason: "COMPLETED",
          closed: true,
          repository: {
            name: TEST_REPO_NAME,
            owner: { login: TEST_OWNER_LOGIN },
          },
          assignees: {
            nodes: [{ login: "contributorA", url: "https://github.com/contributorA" }],
          },
        },
      })),
    };

    const context: Context<"issues.opened"> = {
      eventName: "issues.opened",
      command: null,
      authToken: "",
      commentHandler: {} as Context<"issues.opened">["commentHandler"],
      payload: {
        issue: {
          node_id: TEST_ISSUE_NODE_ID,
          html_url: TEST_ISSUE_URL,
          body: TEST_TASK_DESCRIPTION,
          title: TEST_TASK_TITLE,
          user: { id: 1, type: "User", login: TEST_AUTHOR_LOGIN },
          number: 1,
          created_at: TEST_TIMESTAMP,
          updated_at: TEST_TIMESTAMP,
        },
        repository: {
          private: false,
          name: TEST_REPO_NAME,
          owner: { login: TEST_OWNER_LOGIN },
        },
      } as Context<"issues.opened">["payload"],
      config: {
        jobMatchingThreshold: 0.7,
        alwaysRecommend: 3,
      } as Context<"issues.opened">["config"],
      logger: new Logs("debug") as unknown as Context<"issues.opened">["logger"],
      env: {} as Context<"issues.opened">["env"],
      octokit: mockOctokit as unknown as Context<"issues.opened">["octokit"],
      adapters: {
        supabase: {
          issue: {
            findSimilarIssuesToMatch: mock(async () => [
              { issue_id: "ISSUE_SIMILAR_1", similarity: 0.85 },
              { issue_id: "ISSUE_SIMILAR_1", similarity: 0.85 }, // Duplicate issue match from embeddings
            ]),
          },
        },
        close: mock(async () => {}),
      } as unknown as Context<"issues.opened">["adapters"],
    };

    await issueMatchingWithComment(context);

    // First duplicate comment should be updated
    expect(updatedComments.length).toBe(1);
    expect(updatedComments[0].comment_id).toBe(101);
    expect(updatedComments[0].body).toContain("contributorA");

    // Second duplicate comment should be deleted
    expect(deletedComments.length).toBe(1);
    expect(deletedComments[0].comment_id).toBe(102);

    // No new comment should be created
    expect(createdComments.length).toBe(0);
  });

  it("skips duplicate issue matching on initial issues.labeled event when issue was just created", async () => {
    let isIssueMatchingCalled = false;
    const context: Context<"issues.labeled"> = {
      eventName: "issues.labeled",
      command: null,
      authToken: "",
      commentHandler: {} as Context<"issues.labeled">["commentHandler"],
      payload: {
        issue: {
          node_id: TEST_ISSUE_NODE_ID,
          html_url: TEST_ISSUE_URL,
          body: TEST_TASK_DESCRIPTION,
          title: TEST_TASK_TITLE,
          user: { id: 1, type: "User", login: TEST_AUTHOR_LOGIN },
          number: 1,
          created_at: TEST_TIMESTAMP,
          updated_at: "2025-07-23T08:43:12Z", // 2 seconds later (initial creation with labels)
        },
        repository: {
          private: false,
          name: TEST_REPO_NAME,
          owner: { login: TEST_OWNER_LOGIN },
        },
      } as Context<"issues.labeled">["payload"],
      config: {
        demoFlag: false,
      } as Context<"issues.labeled">["config"],
      logger: new Logs("debug") as unknown as Context<"issues.labeled">["logger"],
      env: {
        EMBEDDINGS_QUEUE_ENABLED: "false",
      } as Context<"issues.labeled">["env"],
      octokit: {} as Context<"issues.labeled">["octokit"],
      adapters: {
        supabase: {
          issue: {
            findSimilarIssuesToMatch: mock(async () => {
              isIssueMatchingCalled = true;
              return [];
            }),
          },
        },
        close: mock(async () => {}),
      } as unknown as Context<"issues.labeled">["adapters"],
    };

    await runPlugin(context as unknown as Context);

    // Should skip issue matching for initial label event
    expect(isIssueMatchingCalled).toBe(false);
  });

  it("deletes all existing recommendation comments when match results are empty", async () => {
    const deletedComments: Array<{ comment_id: number }> = [];

    const mockOctokit = {
      paginate: mock(async () => [
        { id: 201, body: ">[!NOTE]\n>The following contributors may be suitable for this task:\n### [userA](urlA)" },
        { id: 202, body: ">[!NOTE]\n>The following contributors may be suitable for this task:\n### [userB](urlB)" },
      ]),
      rest: {
        issues: {
          listComments: mock(),
          deleteComment: mock(async (params: { comment_id: number }) => {
            deletedComments.push(params);
          }),
        },
      },
      graphql: mock(async () => ({
        node: {
          title: "Ineligible Issue",
          url: "https://github.com/ubiquity/test-repo/issues/10",
          state: "OPEN",
          closed: false,
          repository: {
            name: TEST_REPO_NAME,
            owner: { login: TEST_OWNER_LOGIN },
          },
          assignees: {
            nodes: [], // No assignees -> ineligible
          },
        },
      })),
    };

    const context: Context<"issues.opened"> = {
      eventName: "issues.opened",
      command: null,
      authToken: "",
      commentHandler: {} as Context<"issues.opened">["commentHandler"],
      payload: {
        issue: {
          node_id: TEST_ISSUE_NODE_ID,
          html_url: TEST_ISSUE_URL,
          body: TEST_TASK_DESCRIPTION,
          title: TEST_TASK_TITLE,
          user: { id: 1, type: "User", login: TEST_AUTHOR_LOGIN },
          number: 1,
          created_at: TEST_TIMESTAMP,
          updated_at: TEST_TIMESTAMP,
        },
        repository: {
          private: false,
          name: TEST_REPO_NAME,
          owner: { login: TEST_OWNER_LOGIN },
        },
      } as Context<"issues.opened">["payload"],
      config: {
        jobMatchingThreshold: 0.95,
      } as Context<"issues.opened">["config"],
      logger: new Logs("debug") as unknown as Context<"issues.opened">["logger"],
      env: {} as Context<"issues.opened">["env"],
      octokit: mockOctokit as unknown as Context<"issues.opened">["octokit"],
      adapters: {
        supabase: {
          issue: {
            findSimilarIssuesToMatch: mock(async () => [{ issue_id: "ISSUE_INELIGIBLE", similarity: 0.98 }]),
          },
        },
        close: mock(async () => {}),
      } as unknown as Context<"issues.opened">["adapters"],
    };

    await issueMatchingWithComment(context);

    // Both previous comments should be deleted
    expect(deletedComments.length).toBe(2);
    expect(deletedComments.map((c) => c.comment_id)).toEqual([201, 202]);
  });
});
