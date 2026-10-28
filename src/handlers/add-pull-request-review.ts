import { Context } from "../types/index";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
import { removeAnnotateFootnotes } from "./annotate";
import { buildPullRequestReviewMarkdown, ensurePullRequestIssue } from "./pull-request-review-utils";
import { shouldRedactPrivateRepoComments } from "../utils/privacy";

export async function addPullRequestReview(context: Context<"pull_request_review.submitted">) {
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
    logger.debug("Ignoring pull request review from non-human author", { author: review.user?.login, type: review.user?.type });
    return;
  }

  try {
    if (!pullRequest) {
      logger.warn("Pull request payload missing; cannot store review summary", { reviewId: review.id });
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
      logger.debug("Demo mode active - skipping pull request review storage", { review: review.id, review_url: review.html_url });
      return;
    }

    const queueSettings = getEmbeddingQueueSettings(context.env);
    await supabase.comment.createComment(
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
    logger.ok("Successfully created pull request review summary", review);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error creating pull request review summary", { error, stack: error.stack, review });
    } else {
      logger.error("Error creating pull request review summary", { err: error, review });
    }
  }

  logger.debug("Exiting addPullRequestReview");
}
