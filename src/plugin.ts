import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { createAdapters } from "./adapters/index";
import { updateCronState } from "./cron/workflow";
import { addComments } from "./handlers/add-comments";
import { addReviewComment } from "./handlers/add-review-comments";
import { addIssue } from "./handlers/add-issue";
import { addPullRequest } from "./handlers/add-pull-request";
import { addPullRequestReview } from "./handlers/add-pull-request-review";
import { completeIssue } from "./handlers/complete-issue";
import { deleteComment } from "./handlers/delete-comments";
import { deleteReviewComment } from "./handlers/delete-review-comments";
import { deleteIssues } from "./handlers/delete-issue";
import { issueDedupe } from "./handlers/issue-deduplication";
import { issueMatchingWithComment } from "./handlers/issue-matching";
import { issueTransfer } from "./handlers/transfer-issue";
import { updateComment } from "./handlers/update-comments";
import { updateReviewComment } from "./handlers/update-review-comments";
import { updateIssue } from "./handlers/update-issue";
import { updatePullRequest } from "./handlers/update-pull-request";
import { updatePullRequestReview } from "./handlers/update-pull-request-review";
import { commandHandler, userAnnotate } from "./handlers/user-annotate";
import { isPluginEdit } from "./helpers/plugin-utils";
import { Database } from "./types/database";
import { Context } from "./types/index";
import { isIssueCommentEvent, isIssueEvent, isPullRequestEvent, isPullRequestReviewCommentEvent, isPullRequestReviewEvent } from "./types/typeguards";
import { getEmbeddingQueueSettings } from "./utils/embedding-queue";

export async function initAdapters(context: Context) {
  const { env } = context;

  const supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_KEY);
  const voyageClient = new VoyageAIClient({
    apiKey: env.VOYAGEAI_API_KEY,
  });
  const adapters = await createAdapters(supabase, voyageClient, context);
  //Check the supabase adapter
  const isConnectionValid = await adapters.supabase.super.checkConnection();
  context.logger[isConnectionValid ? "ok" : "error"](`Supabase connection ${isConnectionValid ? "successful" : "failed"}`);

  return adapters;
}

/**
 * The main plugin function. Split for easier testing.
 */
export async function runPlugin(context: Context) {
  const { logger, eventName } = context;

  try {
    if (!context.adapters?.supabase && !context.adapters?.voyage) {
      context.adapters = await initAdapters(context);
    }

    const { enabled: shouldDeferEmbeddings } = getEmbeddingQueueSettings(context.env);

    if (context.command && eventName === "issue_comment.created") {
      return await commandHandler(context as Context<"issue_comment.created">);
    }

    if (isIssueCommentEvent(context)) {
      switch (eventName) {
        case "issue_comment.created":
          await addComments(context as Context<"issue_comment.created">);
          return await userAnnotate(context as Context<"issue_comment.created">);
        case "issue_comment.deleted":
          return await deleteComment(context as Context<"issue_comment.deleted">);
        case "issue_comment.edited":
          return await updateComment(context as Context<"issue_comment.edited">);
      }
    } else if (isPullRequestReviewCommentEvent(context)) {
      switch (eventName) {
        case "pull_request_review_comment.created":
          return await addReviewComment(context as Context<"pull_request_review_comment.created">);
        case "pull_request_review_comment.edited":
          return await updateReviewComment(context as Context<"pull_request_review_comment.edited">);
        case "pull_request_review_comment.deleted":
          return await deleteReviewComment(context as Context<"pull_request_review_comment.deleted">);
      }
    } else if (isPullRequestReviewEvent(context)) {
      switch (eventName) {
        case "pull_request_review.submitted":
          return await addPullRequestReview(context as Context<"pull_request_review.submitted">);
        case "pull_request_review.edited":
          return await updatePullRequestReview(context as Context<"pull_request_review.edited">);
      }
    } else if (isPullRequestEvent(context)) {
      switch (eventName) {
        case "pull_request.opened":
          return await addPullRequest(context as Context<"pull_request.opened">);
        case "pull_request.edited":
          return await updatePullRequest(context as Context<"pull_request.edited">);
      }
    } else if (isIssueEvent(context)) {
      switch (eventName) {
        case "issues.opened":
          await addIssue(context as Context<"issues.opened">);
          if (shouldDeferEmbeddings) {
            logger.debug("Embedding queue enabled; skipping issue matching on open.");
          } else {
            await issueMatchingWithComment(context as Context<"issues.opened">);
          }
          break;
        case "issues.edited":
          if (isPluginEdit(context as Context<"issues.edited">)) {
            logger.info("Plugin edit detected, will run issue matching and checker.");
            if (shouldDeferEmbeddings) {
              logger.debug("Embedding queue enabled; skipping issue matching and dedupe on plugin edit.");
            } else {
              await issueMatchingWithComment(context as Context<"issues.edited">);
              await issueDedupe(context as Context<"issues.edited">);
            }
          } else {
            await updateIssue(context as Context<"issues.edited">);
          }
          break;
        case "issues.deleted":
          await deleteIssues(context as Context<"issues.deleted">);
          break;
        case "issues.transferred":
          await issueTransfer(context as Context<"issues.transferred">);
          break;
        case "issues.closed":
          await completeIssue(context as Context<"issues.closed">);
          break;
      }
    } else if (eventName == "issues.labeled") {
      if (shouldDeferEmbeddings) {
        logger.debug("Embedding queue enabled; skipping issue matching on label.");
        return;
      }
      const labeledContext = context as Context<"issues.labeled">;
      const createdAt = new Date(labeledContext.payload.issue.created_at).getTime();
      const updatedAt = new Date(labeledContext.payload.issue.updated_at).getTime();
      if (!Number.isNaN(createdAt) && !Number.isNaN(updatedAt) && Math.abs(updatedAt - createdAt) < 10000) {
        logger.debug("Skipping issue matching on initial label because issue matching is handled on issues.opened.", {
          created_at: labeledContext.payload.issue.created_at,
          updated_at: labeledContext.payload.issue.updated_at,
        });
        return;
      }
      return await issueMatchingWithComment(labeledContext);
    } else {
      logger.warn(`Unsupported event: ${eventName}`);
      return;
    }
    await updateCronState(context);
    logger.ok(`Exiting plugin`);
  } finally {
    await context.adapters?.close?.();
  }
}
