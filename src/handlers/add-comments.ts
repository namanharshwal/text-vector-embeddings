import { Context } from "../types/index";
import { addIssue } from "./add-issue";
import { removeAnnotateFootnotes } from "./annotate";
import { ensurePullRequestIssue } from "./pull-request-review-utils";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
import { shouldRedactPrivateRepoComments } from "../utils/privacy";

export async function addComments(context: Context<"issue_comment.created">) {
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
  const isPullRequestComment = !!payload.issue.pull_request;
  let issueId = payload.issue.node_id;

  if (comment.user?.type !== "User") {
    logger.debug("Ignoring comment from non-human author", { author: comment.user?.login, type: comment.user?.type });
    return;
  }

  try {
    if (!markdown) {
      logger.warn("Comment body is empty");
    }
    if (isPullRequestComment) {
      logger.debug("Issue comment is on a pull request; linking to PR document", { commentId: comment.id, pullRequestUrl: payload.issue.html_url });
      issueId = (await ensurePullRequestIssue(context, payload.issue)) ?? issueId;
    } else {
      const existingIssue = await supabase.issue.getIssue(issueId);
      if (!existingIssue || existingIssue.length === 0) {
        logger.info("Parent issue not found, creating new issue", { "Issue ID": issueId });
        await addIssue(context);
      }
    }
    const cleanComment = removeAnnotateFootnotes(markdown);
    const queueSettings = getEmbeddingQueueSettings(context.env);

    if (config.demoFlag) {
      logger.debug("Demo mode active - skipping comment storage", { comment: comment.id, comment_url: comment.html_url });
      return;
    }

    await supabase.comment.createComment(
      { markdown: cleanComment, id, author_id: authorId, payload, isPrivate, issue_id: issueId },
      { deferEmbedding: queueSettings.enabled }
    );
    logger.ok(`Successfully created comment!`, comment);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error creating comment:`, { error: error, stack: error.stack, comment: comment });
    } else {
      logger.error(`Error creating comment:`, { err: error, comment: comment });
    }
  }
  logger.debug(`Exiting addComments`);
}
