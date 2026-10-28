import { Context } from "../types/index";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
import { shouldRedactPrivateRepoComments } from "../utils/privacy";

export async function issueTransfer(context: Context<"issues.transferred">) {
  const {
    logger,
    adapters: { supabase, issueStore },
    config,
  } = context;
  const { changes, issue } = context.payload;
  const nodeId = issue.node_id;
  const { new_issue, new_repository } = changes;
  //Fetch the new details of the issue
  const newIssueNodeId = new_issue.node_id;
  const authorType = new_issue.user?.type;
  const isHumanAuthor = authorType === "User";
  const markdownParts = [new_issue.body?.trim() ?? "", new_issue.title?.trim() ?? ""].filter(Boolean);
  let markdown = markdownParts.length > 0 ? markdownParts.join(" ") : null;
  const authorId = new_issue.user?.id || -1;
  const isPrivate = shouldRedactPrivateRepoComments(new_repository.private, config.redactPrivateRepoComments);
  const queueSettings = getEmbeddingQueueSettings(context.env);

  if (!isHumanAuthor) {
    logger.debug("Issue author is not human; storing issue without embeddings.", {
      author: new_issue.user?.login,
      type: authorType,
      issue: new_issue.number,
    });
    markdown = null;
  }

  //Delete the issue from the old repository
  //Create the new issue in the new repository
  try {
    await supabase.issue.deleteIssue(nodeId);
    await supabase.issue.createIssue(
      { id: newIssueNodeId, payload: new_issue, isPrivate, markdown, author_id: authorId },
      { deferEmbedding: queueSettings.enabled }
    );
    if (isHumanAuthor) {
      await issueStore.updateIssue(issue.html_url, new_issue.html_url);
    } else {
      await issueStore.removeIssue(issue.html_url);
    }
    logger.ok(`Successfully transferred issue!`, new_issue);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error transferring issue:`, { error: error, stack: error.stack, issue: new_issue });
      throw error;
    } else {
      logger.error(`Error transferring issue:`, { err: error, error: new Error(), issue: new_issue });
      throw error;
    }
  }
  logger.debug(`Exiting issueTransfer`);
}
