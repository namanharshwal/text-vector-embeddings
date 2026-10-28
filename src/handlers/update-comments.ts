import { Context } from "../types/index";
import { addIssue } from "./add-issue";
import { checkIfAnnotateFootNoteExists, removeAnnotateFootnotes } from "./annotate";
import { ensurePullRequestIssue } from "./pull-request-review-utils";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
import { shouldRedactPrivateRepoComments } from "../utils/privacy";

export async function updateComment(context: Context<"issue_comment.edited">) {
  const {
    logger,
    adapters: { supabase },
    octokit,
    payload,
    config,
  } = context;
  const markdown = payload.comment.body;
  const authorId = payload.comment.user?.id || -1;
  const id = payload.comment.node_id;
  const isPrivate = shouldRedactPrivateRepoComments(payload.repository.private, config.redactPrivateRepoComments);
  const isPullRequestComment = !!payload.issue.pull_request;
  let issueId = payload.issue.node_id;

  if (payload.comment.user?.type !== "User") {
    logger.debug("Ignoring comment update from non-human author", { author: payload.comment.user?.login, type: payload.comment.user?.type });
    return;
  }

  // Fetch the previous comment and update it in the db
  try {
    if (!markdown) {
      logger.warn("Comment body is empty");
    }
    if (isPullRequestComment) {
      logger.debug("Issue comment update is on a pull request; linking to PR document", {
        commentId: payload.comment.id,
        pullRequestUrl: payload.issue.html_url,
      });
      issueId = (await ensurePullRequestIssue(context, payload.issue)) ?? issueId;
    } else {
      const existingIssue = await supabase.issue.getIssue(issueId);
      if (!existingIssue || existingIssue.length === 0) {
        logger.info("Parent issue not found, creating new issue");
        await addIssue(context);
      }
    }
    const cleanedComment = removeAnnotateFootnotes(markdown);
    const queueSettings = getEmbeddingQueueSettings(context.env);
    if (checkIfAnnotateFootNoteExists(markdown)) {
      await octokit.rest.issues.updateComment({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        comment_id: payload.comment.id,
        body: cleanedComment,
      });
    }
    if (config.demoFlag) {
      logger.debug("Demo mode active - skipping comment update in database", { comment: payload.comment.id, comment_url: payload.comment.html_url });
      return;
    }

    await supabase.comment.updateComment(
      { markdown: cleanedComment, id, author_id: authorId, payload, isPrivate, issue_id: issueId },
      { deferEmbedding: queueSettings.enabled }
    );
    logger.ok(`Successfully updated comment! ${payload.comment.id}`, payload.comment);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error updating comment:`, { error: error, stack: error.stack, comment: payload.comment });
      throw error;
    } else {
      logger.error(`Error updating comment:`, { err: error, comment: payload.comment });
      throw error;
    }
  }

  logger.debug(`Exiting updateComment`);
}
