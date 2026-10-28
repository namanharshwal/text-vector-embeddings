import { Context } from "../types/index";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
import { shouldRedactPrivateRepoComments } from "../utils/privacy";
import { removeAnnotateFootnotes } from "./annotate";
import { buildReviewCommentMarkdown, ensurePullRequestIssue, fetchParentReviewComment, formatReviewThreadContext } from "./pull-request-review-utils";

export async function addReviewComment(context: Context<"pull_request_review_comment.created">) {
  const {
    logger,
    adapters: { supabase },
    payload,
    config,
  } = context;
  const comment = payload.comment;
  const markdown = comment.body;
  const authorId = comment.user?.id || -1;
  const id = comment.node_id;
  const isPrivate = shouldRedactPrivateRepoComments(payload.repository.private, config.redactPrivateRepoComments);
  const pullRequest = payload.pull_request;

  const isHumanAuthor = comment.user?.type === "User";
  const isThreadRoot = comment.in_reply_to_id == null;
  if (!isHumanAuthor && !isThreadRoot) {
    logger.debug("Ignoring review comment from non-human author", { author: comment.user?.login, type: comment.user?.type });
    return;
  }
  if (!isHumanAuthor && isThreadRoot) {
    logger.debug("Allowing bot-authored root review comment for thread context", {
      author: comment.user?.login,
      type: comment.user?.type,
      commentId: comment.id,
    });
  }

  try {
    if (!markdown) {
      logger.warn("Review comment body is empty", { comment });
      return;
    }
    if (!pullRequest) {
      logger.warn("Pull request payload missing; cannot store review comment", { commentId: comment.id });
      return;
    }

    const issueId = await ensurePullRequestIssue(context, pullRequest);
    const cleanComment = removeAnnotateFootnotes(markdown);
    const enrichedComment = buildReviewCommentMarkdown({
      body: cleanComment,
      diff_hunk: comment.diff_hunk ?? null,
      path: comment.path ?? null,
      line: comment.line ?? null,
      start_line: comment.start_line ?? null,
      original_line: comment.original_line ?? null,
      original_start_line: comment.original_start_line ?? null,
      side: comment.side ?? null,
      start_side: comment.start_side ?? null,
    });
    if (!enrichedComment) {
      logger.warn("Review comment body is empty", { comment });
      return;
    }
    let finalMarkdown = enrichedComment;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const parentId = comment.in_reply_to_id ?? null;
    if (parentId) {
      const parentContext = await fetchParentReviewComment(context, owner, repo, parentId);
      if (parentContext) {
        finalMarkdown = formatReviewThreadContext(enrichedComment, parentContext.markdown, parentContext.author);
      }
    }

    if (config.demoFlag) {
      logger.debug("Demo mode active - skipping review comment storage", { comment: comment.id, comment_url: comment.html_url });
      return;
    }

    const queueSettings = getEmbeddingQueueSettings(context.env);
    await supabase.comment.createComment(
      { markdown: finalMarkdown, id, author_id: authorId, payload, isPrivate, issue_id: issueId ?? null, docType: "review_comment" },
      { deferEmbedding: queueSettings.enabled }
    );
    logger.ok("Successfully created review comment", comment);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error creating review comment", { error, stack: error.stack, comment });
    } else {
      logger.error("Error creating review comment", { err: error, comment });
    }
  }

  logger.debug("Exiting addReviewComment");
}
