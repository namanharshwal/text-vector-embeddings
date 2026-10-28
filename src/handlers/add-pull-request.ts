import { Context } from "../types/index";
import { cleanContent } from "./issue-deduplication";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
import { buildPullRequestMarkdown } from "./pull-request-review-utils";
import { shouldRedactPrivateRepoComments } from "../utils/privacy";

export async function addPullRequest(context: Context<"pull_request.opened">) {
  const {
    logger,
    adapters: { supabase },
    payload,
    config,
  } = context;
  const pullRequest = payload.pull_request;
  const authorType = pullRequest.user?.type;
  const isHumanAuthor = authorType === "User";
  const markdown = isHumanAuthor ? buildPullRequestMarkdown(pullRequest) : null;
  const authorId = pullRequest.user?.id || -1;
  const id = pullRequest.node_id;
  const isPrivate = shouldRedactPrivateRepoComments(payload.repository.private, config.redactPrivateRepoComments);

  if (!isHumanAuthor) {
    logger.debug("Pull request author is not human; storing PR without embeddings.", {
      author: pullRequest.user?.login,
      type: authorType,
      pullRequest: pullRequest.number,
    });
  }

  try {
    if (isHumanAuthor && !markdown) {
      logger.error("Pull request body/title is empty", { pullRequest });
      return;
    }
    const cleanedPullRequest = isHumanAuthor && markdown ? await cleanContent(context, markdown) : null;
    const queueSettings = getEmbeddingQueueSettings(context.env);

    if (config.demoFlag) {
      logger.debug("Demo mode active - skipping pull request storage", { pullRequest: pullRequest.number, pull_request_url: pullRequest.html_url });
      return;
    }

    await supabase.issue.createIssue(
      { id, docType: "pull_request", payload, isPrivate, markdown: cleanedPullRequest, author_id: authorId },
      { deferEmbedding: queueSettings.enabled }
    );
    logger.ok("Successfully created pull request!", pullRequest);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error creating pull request:", { error: error, stack: error.stack, pullRequest });
      throw error;
    } else {
      logger.error("Error creating pull request:", { err: error, pullRequest });
      throw error;
    }
  }
  logger.debug("Exiting addPullRequest");
}
