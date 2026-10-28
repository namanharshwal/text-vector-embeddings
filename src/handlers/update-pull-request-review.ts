import { Context } from "../types/index";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
import { removeAnnotateFootnotes } from "./annotate";
import { buildPullRequestReviewMarkdown, ensurePullRequestIssue } from "./pull-request-review-utils";
import { shouldRedactPrivateRepoComments } from "../utils/privacy";

export async function updatePullRequestReview(context: Context<"pull_request_review.edited">) {
  const {
    logger,
    adapters: { supabase },
    payload,
    config,
  } = context;
  const review = payload.review;
  const pullRequest = payload.pull_request;

  if (!review) {
    logger.warn("Pull request review payload is missing", { payload });
    return;
  }

  if (review.user?.type !== "User") {
    logger.debug("Ignoring pull request review update from non-human author", { author: review.user?.login, type: review.user?.type });
    return;
  }

  try {
    if (!pullRequest) {
      logger.warn("Pull request payload missing; cannot update review summary", { reviewId: review.id });
      return;
    }

    const issueId = await ensurePullRequestIssue(context, pullRequest);
    const cleanedBody = removeAnnotateFootnotes(review.body ?? "");
    const reviewMarkdown = buildPullRequestReviewMarkdown({ body: cleanedBody, state: review.state ?? null }, pullRequest);
    if (!reviewMarkdown) {
      logger.warn("Review summary is empty", { review });
      return;
    }

    if (config.demoFlag) {
      logger.debug("Demo mode active - skipping pull request review update in database", { review: review.id, review_url: review.html_url });
      return;
    }

    const queueSettings = getEmbeddingQueueSettings(context.env);
    await supabase.comment.updateComment(
      {
        markdown: reviewMarkdown,
        id: review.node_id ?? `${review.id}`,
        author_id: review.user?.id ?? -1,
        payload,
        isPrivate: shouldRedactPrivateRepoComments(payload.repository.private, config.redactPrivateRepoComments),
        issue_id: issueId ?? pullRequest.node_id ?? null,
        docType: "pull_request_review",
      },
      { deferEmbedding: queueSettings.enabled }
    );
    logger.ok("Successfully updated pull request review summary", review);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error updating pull request review summary", { error, stack: error.stack, review });
      throw error;
    } else {
      logger.error("Error updating pull request review summary", { err: error, review });
      throw error;
    }
  }

  logger.debug("Exiting updatePullRequestReview");
}
