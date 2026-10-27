import { Context } from "../types/index";
import { annotate, AnnotateCommentReference } from "./annotate";
import { issueMatching, issueMatchingForUsers } from "./issue-matching";

export function parseCommentReference(commentUrl: string): AnnotateCommentReference | null {
  const fullUrlMatch = commentUrl.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/\d+#issuecomment-(\d+)$/i);
  if (fullUrlMatch) {
    return {
      owner: fullUrlMatch[1],
      repo: fullUrlMatch[2],
      id: fullUrlMatch[3],
    };
  }

  const idOnlyMatch = commentUrl.match(/#issuecomment-(\d+)$/);
  return idOnlyMatch ? { id: idOnlyMatch[1] } : null;
}

// GitHub usernames are 1-39 chars, alphanumeric or hyphen, no leading/trailing hyphen.
const GITHUB_LOGIN_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function normalizeUserLogins(segments: string[]): string[] {
  return segments
    .flatMap((segment) => segment.split(","))
    .map((user) => user.trim().replace(/^@/, ""))
    .filter(Boolean)
    .filter((user) => GITHUB_LOGIN_REGEX.test(user));
}

function parseUserLoginsFromTokens(tokens: string[]): string[] {
  return normalizeUserLogins(tokens);
}

function buildRecommendationComment(result: NonNullable<Awaited<ReturnType<typeof issueMatching>>>, requestedLogins: string[]): string {
  const formattedLogins = requestedLogins.map((login) => `@${login}`).join(", ");
  const lines: string[] = [">[!NOTE]", requestedLogins.length > 0 ? `>Recommendation results (filtered): ${formattedLogins}` : ">Recommendation results:"];

  if (!result.sortedContributors.length) {
    lines.push("> No suitable contributors found.");
    return lines.join("\n");
  }

  for (const { login, matches } of result.sortedContributors) {
    lines.push(`>### [${login}](https://www.github.com/${login})`);
    if (matches.length) {
      for (const match of matches.slice(0, 3)) {
        lines.push(match);
      }
    } else {
      lines.push("> No matches found.");
    }
  }

  return lines.join("\n");
}

async function postCommandResponse(context: Context<"issue_comment.created">, body: string, forceTag = false) {
  const options = forceTag ? { raw: true, commentKind: "command-response" } : { raw: true };
  await context.commentHandler.postComment(context, context.logger.info(body), options);
}

export async function commandHandler(context: Context<"issue_comment.created">) {
  const { logger } = context;

  if (!context.command) {
    return;
  }

  if (context.command.name === "annotate") {
    const commentUrl = context.command.parameters.commentUrl ?? null;
    const scope = context.command.parameters.scope ?? "org";
    let commentReference: AnnotateCommentReference | null = null;
    if (commentUrl) {
      commentReference = parseCommentReference(commentUrl);
      if (!commentReference) {
        throw logger.error("Invalid comment URL");
      }
    }
    await annotate(context, commentReference, scope);
  }
}

export async function userAnnotate(context: Context<"issue_comment.created">) {
  const { logger } = context;
  const comment = context.payload.comment;
  const splitComment = comment.body.trim().split(/\s+/);
  const commandName = splitComment[0].replace("/", "");

  let commentReference: AnnotateCommentReference | null = null;
  let scope = "org";

  if (commandName === "annotate") {
    if (splitComment.length > 1) {
      if (splitComment.length === 3) {
        const commentUrl = splitComment[1];
        scope = splitComment[2];

        if (scope !== "global" && scope !== "org" && scope !== "repo") {
          throw logger.error("Invalid scope");
        }

        commentReference = parseCommentReference(commentUrl);
        if (!commentReference) {
          throw logger.error("Invalid comment URL");
        }
      } else {
        throw logger.error("Invalid parameters");
      }
    }
    await annotate(context, commentReference, scope);
  }

  if (commandName === "recommendation") {
    const requestedLogins = parseUserLoginsFromTokens(splitComment.slice(1));
    const result = requestedLogins.length > 0 ? await issueMatchingForUsers(context, requestedLogins) : await issueMatching(context);

    if (!result) {
      await postCommandResponse(context, ">[!NOTE]\n> No suitable contributors found.", true);
      return;
    }

    await postCommandResponse(context, buildRecommendationComment(result, requestedLogins), true);
  }
}
