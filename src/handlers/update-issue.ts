import { Context } from "../types/index";
import { cleanContent } from "./issue-deduplication";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
import { shouldRedactPrivateRepoComments } from "../utils/privacy";

export async function updateIssue(context: Context<"issues.edited">) {
  const {
    logger,
    adapters: { supabase, issueStore },
    payload,
    config,
  } = context;
  const id = payload.issue.node_id;
  const isPrivate = shouldRedactPrivateRepoComments(payload.repository.private, config.redactPrivateRepoComments);
  const authorType = payload.issue.user?.type;
  const isHumanAuthor = authorType === "User";
  let markdown = payload.issue.body && payload.issue.title ? payload.issue.body + " " + payload.issue.title : null;
  const authorId = payload.issue.user?.id || -1;
  // Fetch the previous issue and update it in the db

  if (!isHumanAuthor) {
    logger.debug("Issue author is not human; storing issue without embeddings.", {
      author: payload.issue.user?.login,
      type: authorType,
      issue: payload.issue.number,
    });
    markdown = null;
  }

  try {
    if (isHumanAuthor && !markdown) {
      logger.warn("Issue body is empty");
      return;
    }
    //clean issue by removing footnotes
    const cleanedIssue = isHumanAuthor && markdown ? await cleanContent(context, markdown) : null;
    const queueSettings = getEmbeddingQueueSettings(context.env);

    if (config.demoFlag) {
      logger.debug("Demo mode active - skipping issue update in database", { issue: payload.issue.number, issue_url: payload.issue.html_url });
      return;
    }

    await supabase.issue.updateIssue({ markdown: cleanedIssue, id, payload, isPrivate, author_id: authorId }, { deferEmbedding: queueSettings.enabled });
    if (isHumanAuthor) {
      await issueStore.addIssue(payload.issue.html_url);
    }
    logger.ok(`Successfully updated issue! ${payload.issue.id}`, payload.issue);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error updating issue:`, { error: error, stack: error.stack, issue: payload.issue });
      throw error;
    } else {
      logger.error(`Error updating issue:`, { err: error, issue: payload.issue });
      throw error;
    }
  }
  logger.debug(`Exiting updateIssue`);
}
