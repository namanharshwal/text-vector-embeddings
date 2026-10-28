import { Context } from "../types/index";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
import { removeAnnotateFootnotes } from "./annotate";
import { shouldRedactPrivateRepoComments } from "../utils/privacy";

type PullRequestContext = Context;

type PullRequestPayload = {
  node_id?: string | null;
  title?: string | null;
  body?: string | null;
  user?: { id?: number | null; login?: string | null; type?: string | null } | null;
  html_url?: string | null;
};

type ReviewCommentPayload = {
  body?: string | null;
  diff_hunk?: string | null;
  path?: string | null;
  line?: number | null;
  start_line?: number | null;
  original_line?: number | null;
  original_start_line?: number | null;
  side?: string | null;
  start_side?: string | null;
  in_reply_to_id?: number | null;
};

export function buildPullRequestMarkdown(pullRequest: PullRequestPayload): string | null {
  const body = pullRequest.body?.trim() ?? "";
  const title = pullRequest.title?.trim() ?? "";
  const combined = [body, title].filter(Boolean).join(" ").trim();
  return combined || null;
}

type PullRequestReviewPayload = {
  body?: string | null;
  state?: string | null;
};

export function buildPullRequestReviewMarkdown(review: PullRequestReviewPayload, pullRequest?: PullRequestPayload | null): string | null {
  const body = review.body?.trim() ?? "";
  const state = review.state?.trim() ?? "";
  const title = pullRequest?.title?.trim() ?? "";
  const parts: string[] = [];

  if (body) {
    parts.push(body);
  }
  if (state) {
    parts.push(`Review state: ${state}`);
  }
  if (title) {
    parts.push(`PR title: ${title}`);
  }

  return parts.join("\n\n").trim() || null;
}

function formatReviewCommentLocation(comment: ReviewCommentPayload): string | null {
  const path = comment.path?.trim() ?? "";
  const line = comment.line ?? comment.original_line ?? null;
  const startLine = comment.start_line ?? comment.original_start_line ?? null;
  const side = comment.side ?? comment.start_side ?? null;
  const parts: string[] = [];

  if (path) {
    parts.push(`File: ${path}`);
  }
  if (startLine !== null && line !== null && startLine !== line) {
    parts.push(`Lines: ${startLine}-${line}`);
  } else if (line !== null) {
    parts.push(`Line: ${line}`);
  }
  if (side) {
    parts.push(`Side: ${side}`);
  }

  return parts.length > 0 ? parts.join(" | ") : null;
}

export function buildReviewCommentMarkdown(comment: ReviewCommentPayload): string | null {
  const body = comment.body?.trim() ?? "";
  if (!body) {
    return null;
  }

  const diff = comment.diff_hunk?.trim() ?? "";
  if (!diff) {
    return body;
  }

  const location = formatReviewCommentLocation(comment);
  const locationLine = location ? `${location}\n` : "";

  return `${body}\n\n${locationLine}\`\`\`diff\n${diff}\n\`\`\``;
}

export function formatReviewThreadContext(base: string, parent: string, parentAuthor?: string | null): string {
  const header = parentAuthor ? `In reply to ${parentAuthor}:` : "In reply to:";
  return `${base}\n\n---\n${header}\n${parent}`;
}

type ParentReviewContext = {
  markdown: string;
  author?: string | null;
};

export async function fetchParentReviewComment(
  context: PullRequestContext,
  owner: string,
  repo: string,
  parentId: number
): Promise<ParentReviewContext | null> {
  try {
    const { data } = await context.octokit.rest.pulls.getReviewComment({
      owner,
      repo,
      comment_id: parentId,
    });
    const isHumanAuthor = data.user?.type === "User";
    const isThreadRoot = data.in_reply_to_id == null;
    if (!isHumanAuthor && !isThreadRoot) {
      context.logger.debug("Skipping parent review comment from non-human author", {
        parentId,
        author: data.user?.login ?? null,
        type: data.user?.type ?? null,
      });
      return null;
    }
    if (!isHumanAuthor && isThreadRoot) {
      context.logger.debug("Including bot-authored root review comment for thread context", {
        parentId,
        author: data.user?.login ?? null,
      });
    }
    const cleanedBody = removeAnnotateFootnotes(data.body ?? "");
    const markdown = buildReviewCommentMarkdown({
      body: cleanedBody,
      diff_hunk: data.diff_hunk ?? null,
      path: data.path ?? null,
      line: data.line ?? null,
      start_line: data.start_line ?? null,
      original_line: data.original_line ?? null,
      original_start_line: data.original_start_line ?? null,
      side: data.side ?? null,
      start_side: data.start_side ?? null,
    });
    if (!markdown) {
      return null;
    }
    return { markdown, author: data.user?.login ?? null };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : { stack: String(error) };
    context.logger.warn("Failed to fetch parent review comment", {
      error: normalizedError,
      parentId,
      owner,
      repo,
    });
    return null;
  }
}

export async function ensurePullRequestIssue(context: PullRequestContext, pullRequest: PullRequestPayload): Promise<string | null> {
  const {
    logger,
    adapters: { supabase },
    payload,
    config,
  } = context;

  const id = pullRequest.node_id ?? "";
  if (!id) {
    logger.warn("Pull request node_id is missing; cannot link review comment");
    return null;
  }

  const existing = await supabase.issue.getIssue(id);
  if (existing && existing.length > 0) {
    return id;
  }

  const authorType = pullRequest.user?.type ?? null;
  const isHumanAuthor = authorType === "User";
  const markdown = isHumanAuthor ? buildPullRequestMarkdown(pullRequest) : null;

  if (!isHumanAuthor) {
    logger.debug("Pull request author is not human; storing issue without embeddings.", {
      author: pullRequest.user?.login ?? null,
      type: authorType,
      pullRequestUrl: pullRequest.html_url,
    });
  }

  if (isHumanAuthor && !markdown) {
    logger.warn("Pull request title/body is empty; skipping PR issue creation", { pullRequestUrl: pullRequest.html_url });
    return id;
  }

  if (config.demoFlag) {
    logger.debug("Demo mode active - skipping PR issue storage", { pullRequestUrl: pullRequest.html_url });
    return id;
  }

  const authorId = pullRequest.user?.id ?? -1;
  const isPrivate = shouldRedactPrivateRepoComments(payload.repository?.private ?? false, config.redactPrivateRepoComments);
  const queueSettings = getEmbeddingQueueSettings(context.env);

  await supabase.issue.createIssue(
    {
      id,
      docType: "pull_request",
      payload: payload as Record<string, unknown>,
      isPrivate,
      markdown,
      author_id: authorId,
    },
    { deferEmbedding: queueSettings.enabled }
  );

  logger.info("Created PR issue entry for review comment linkage", { id, pullRequestUrl: pullRequest.html_url });
  return id;
}
