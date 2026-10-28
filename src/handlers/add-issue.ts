import { Context } from "../types/index";
import { cleanContent } from "./issue-deduplication";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
import { shouldRedactPrivateRepoComments } from "../utils/privacy";

export async function addIssue(context: Context<"issues.opened" | "issue_comment.created" | "issue_comment.edited">) {
  const {
    logger,
    adapters: { supabase, issueStore },
    payload,
    config,
  } = context;
  const issue = payload.issue;
  const authorType = issue.user?.type;
  const isHumanAuthor = authorType === "User";
  let markdown = payload.issue.body && payload.issue.title ? `${payload.issue.body} ${payload.issue.title}` : null;
  const authorId = issue.user?.id || -1;
  const id = issue.node_id;
  const isPrivate = shouldRedactPrivateRepoComments(payload.repository.private, config.redactPrivateRepoComments);

  if (!isHumanAuthor) {
    logger.debug("Issue author is not human; storing issue without embeddings.", {
      author: issue.user?.login,
      type: authorType,
      issue: issue.number,
    });
    markdown = null;
  }

  try {
    if (isHumanAuthor && !markdown) {
      logger.warn("Issue body is empty", { issue });
      return;
    }
    const cleanedIssue = isHumanAuthor && markdown ? await cleanContent(context, markdown) : null;
    const queueSettings = getEmbeddingQueueSettings(context.env);

    if (config.demoFlag) {
      logger.debug("Demo mode active - skipping issue storage", { issue: issue.number, issue_url: issue.html_url });
      return;
    }

    await supabase.issue.createIssue({ id, payload, isPrivate, markdown: cleanedIssue, author_id: authorId }, { deferEmbedding: queueSettings.enabled });
    if (isHumanAuthor) {
      await issueStore.addIssue(issue.html_url);
    }
    logger.ok(`Successfully created issue!`, issue);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error creating issue:`, { error: error, issue: issue });
      throw error;
    } else {
      logger.error(`Error creating issue:`, { err: error, issue: issue });
      throw error;
    }
  }
  logger.debug(`Exiting addIssue`);
}
