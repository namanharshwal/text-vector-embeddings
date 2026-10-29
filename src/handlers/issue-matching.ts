import { IssueSimilaritySearchResult } from "../adapters/supabase/helpers/issues";
import { Context } from "../types/index";

export interface IssueGraphqlResponse {
  node: {
    title: string;
    url: string;
    state: string;
    stateReason: string;
    closed: boolean;
    repository: {
      owner: {
        login: string;
      };
      name: string;
    };
    assignees: {
      nodes: Array<{
        login: string;
        url: string;
      }>;
    };
  };
  similarity: number;
}

type IssueNodeResponse = IssueGraphqlResponse | { node: null };

type IssueCommentSummary = {
  id: number;
  body?: string | null;
};

function hasIssueNode(response: IssueNodeResponse): response is IssueGraphqlResponse {
  return response.node !== null;
}

export async function issueMatchingWithComment(context: Context<"issues.opened" | "issues.edited" | "issues.labeled">) {
  const { logger, octokit, payload } = context;
  const issue = payload.issue;
  const commentStart = ">The following contributors may be suitable for this task:";

  const result = await issueMatching(context);

  if (!result) {
    return;
  }

  const { matchResultArray, sortedContributors } = result;

  // Fetch if any previous comment exists
  const listIssues = (await octokit.paginate(octokit.rest.issues.listComments, {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: issue.number,
  })) as IssueCommentSummary[];

  //Check if any previous recommendation comments exist
  const existingComments = listIssues.filter((comment) => comment.body && comment.body.includes(">[!NOTE]" + "\n" + commentStart));

  if (matchResultArray.size === 0) {
    if (existingComments.length > 0) {
      // If previous recommendation comments exist, delete them all
      for (const comment of existingComments) {
        await octokit.rest.issues.deleteComment({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          comment_id: comment.id,
        });
      }
    }
    logger.debug("No suitable contributors found");
    return;
  }

  // Use alwaysRecommend if specified
  const numToShow = context.config.alwaysRecommend || 3;
  const limitedContributors = new Map(sortedContributors.slice(0, numToShow).map(({ login, matches }) => [login, matches]));

  const comment = commentBuilder(limitedContributors);

  logger.debug("Comment to be added", { comment });

  if (existingComments.length > 0) {
    // Update the first existing recommendation comment
    await context.octokit.rest.issues.updateComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      comment_id: existingComments[0].id,
      body: comment,
    });
    // Delete any excess duplicate recommendation comments that may have been created
    for (const duplicateComment of existingComments.slice(1)) {
      await context.octokit.rest.issues.deleteComment({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        comment_id: duplicateComment.id,
      });
    }
  } else {
    await context.octokit.rest.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.issue.number,
      body: comment,
    });

    // Reconcile potential concurrent empty-snapshot creation race conditions
    const refreshedComments = (await octokit.paginate(octokit.rest.issues.listComments, {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: issue.number,
    })) as IssueCommentSummary[];

    const postCreateMatches = refreshedComments.filter((c) => c.body && c.body.includes(">[!NOTE]" + "\n" + commentStart));
    if (postCreateMatches.length > 1) {
      postCreateMatches.sort((a, b) => a.id - b.id);
      for (const duplicate of postCreateMatches.slice(1)) {
        try {
          await octokit.rest.issues.deleteComment({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            comment_id: duplicate.id,
          });
        } catch (err) {
          logger.debug("Duplicate comment already deleted or failed deletion", { error: err as Error });
        }
      }
    }
  }
}

type IssueMatchingEvents = "issues.opened" | "issues.edited" | "issues.labeled" | "issue_comment.created";

/**
 * Checks if the current issue is a duplicate of an existing issue.
 * If a similar completed issue is found, it will add a comment to the issue with the assignee(s) of the similar issue.
 * @param context The context object
 **/
export async function issueMatching(context: Context<IssueMatchingEvents>) {
  return issueMatchingInternal(context, {});
}

export async function issueMatchingForUsers(context: Context<IssueMatchingEvents>, users: string[]) {
  const uniqueUsers = Array.from(new Set(users.map((u) => u.trim()).filter(Boolean)));
  return issueMatchingInternal(context, {
    allowedLogins: new Set(uniqueUsers),
    ensureLogins: uniqueUsers,
    forceThresholdZero: true,
    topK: 50,
    includeNonCompleted: true,
  });
}

type IssueMatchingInternalOptions = {
  allowedLogins?: Set<string>;
  ensureLogins?: string[];
  forceThresholdZero?: boolean;
  topK?: number;
  includeNonCompleted?: boolean;
};

async function issueMatchingInternal(context: Context<IssueMatchingEvents>, options: IssueMatchingInternalOptions) {
  const {
    logger,
    adapters: { supabase },
    payload,
  } = context;
  const issue = payload.issue;
  const authorType = issue.user?.type;
  const isHumanAuthor = authorType === "User";
  if (!isHumanAuthor) {
    logger.debug("Skipping issue matching for non-human author.", {
      author: issue.user?.login,
      type: authorType,
      issue: issue.number,
    });
    return null;
  }
  const issueContent = issue.body + issue.title;
  const matchResultArray: Map<string, Array<string>> = new Map();

  // If alwaysRecommend is enabled, use a lower threshold to ensure we get enough recommendations
  const threshold =
    options.forceThresholdZero || (context.config.alwaysRecommend && context.config.alwaysRecommend > 0) ? 0 : context.config.jobMatchingThreshold;

  const similarIssues = await supabase.issue.findSimilarIssuesToMatch({
    markdown: issueContent,
    threshold: threshold,
    currentId: issue.node_id,
    topK: options.topK,
  });

  if (similarIssues && similarIssues.length > 0) {
    // Deduplicate similar issues by issue_id to prevent duplicate calculations
    const uniqueSimilarIssues = similarIssues.filter((issue, index, self) => index === self.findIndex((t) => t.issue_id === issue.issue_id));
    uniqueSimilarIssues.sort((a: IssueSimilaritySearchResult, b: IssueSimilaritySearchResult) => b.similarity - a.similarity); // Sort by similarity
    const fetchPromises = uniqueSimilarIssues.map(async (issue: IssueSimilaritySearchResult) => {
      try {
        const issueObject: IssueNodeResponse = await context.octokit.graphql(
          /* GraphQL */
          `
            query ($issueNodeId: ID!) {
              node(id: $issueNodeId) {
                ... on Issue {
                  title
                  url
                  state
                  repository {
                    name
                    owner {
                      login
                    }
                  }
                  stateReason
                  closed
                  assignees(first: 10) {
                    nodes {
                      login
                      url
                    }
                  }
                }
              }
            }
          `,
          { issueNodeId: issue.issue_id }
        );
        if (!hasIssueNode(issueObject)) {
          context.logger.warn("Skipping non-issue node in recommendations.", { issueNodeId: issue.issue_id });
          return null;
        }
        issueObject.similarity = issue.similarity;
        return issueObject;
      } catch (error) {
        context.logger.error(`Failed to fetch issue ${issue.issue_id}: ${error}`, { issue });
        return null;
      }
    });
    const issueList = await Promise.allSettled(fetchPromises);

    logger.debug("Fetched similar issues", { issueList });
    issueList.forEach((issuePromise: PromiseSettledResult<IssueGraphqlResponse | null>) => {
      if (!issuePromise || issuePromise.status === "rejected" || !issuePromise.value) {
        return;
      }
      const issue = issuePromise.value as IssueGraphqlResponse;
      const hasAssignees = issue.node.assignees.nodes.length > 0;
      const isCompletedWithAssignees = issue.node.closed && issue.node.stateReason === "COMPLETED" && hasAssignees;
      const isEligible = options.includeNonCompleted ? hasAssignees : isCompletedWithAssignees;

      if (isEligible) {
        const assignees = issue.node.assignees.nodes;
        // Deduplicate assignees by login
        const uniqueAssignees = assignees.filter((assignee, index, self) => index === self.findIndex((a) => a.login === assignee.login));
        uniqueAssignees.forEach((assignee: { login: string; url: string }) => {
          if (options.allowedLogins && !options.allowedLogins.has(assignee.login)) {
            return;
          }
          const similarityPercentage = Math.round(issue.similarity * 100);
          const issueLink = issue.node.url.replace(/https?:\/\/github.com/, "https://www.github.com");
          const matchLine = `> \`${similarityPercentage}% Match\` [${issue.node.repository.owner.login}/${issue.node.repository.name}#${issue.node.url.split("/").pop()}](${issueLink})`;

          const existingMatches = matchResultArray.get(assignee.login);
          if (existingMatches) {
            if (!existingMatches.includes(matchLine)) {
              existingMatches.push(matchLine);
            }
          } else {
            matchResultArray.set(assignee.login, [matchLine]);
          }
        });
      }
    });

    if (options.ensureLogins) {
      for (const login of options.ensureLogins) {
        if (!matchResultArray.has(login)) {
          matchResultArray.set(login, []);
        }
      }
    }

    logger.debug("Matched issues", { matchResultArray, length: matchResultArray.size });

    // Convert Map to array and sort by highest similarity
    const sortedContributors = Array.from(matchResultArray.entries())
      .map(([login, matches]) => ({
        login,
        matches,
        maxSimilarity: matches.length ? Math.max(...matches.map((match) => parseInt(match.match(/`(\d+)% Match`/)?.[1] || "0"))) : 0,
      }))
      .sort((a, b) => b.maxSimilarity - a.maxSimilarity);

    logger.debug("Sorted contributors", { sortedContributors });
    return { matchResultArray, similarIssues: uniqueSimilarIssues, sortedContributors };
  }

  if (options.ensureLogins && options.ensureLogins.length > 0) {
    for (const login of options.ensureLogins) {
      if (!matchResultArray.has(login)) {
        matchResultArray.set(login, []);
      }
    }
    const sortedContributors = Array.from(matchResultArray.entries())
      .map(([login, matches]) => ({
        login,
        matches,
        maxSimilarity: 0,
      }))
      .sort((a, b) => b.maxSimilarity - a.maxSimilarity);
    return { matchResultArray, similarIssues: [], sortedContributors };
  }

  logger.info(`Exiting issueMatching handler!`, { similarIssues: similarIssues || "No similar issues found" });

  return null;
}

/**
 * Builds the comment to be added to the issue
 * @param matchResultArray The array of issues to be matched
 * @returns The comment to be added to the issue
 */
function commentBuilder(matchResultArray: Map<string, Array<string>>): string {
  const commentLines: string[] = [">[!NOTE]", ">The following contributors may be suitable for this task:"];
  matchResultArray.forEach((issues: Array<string>, assignee: string) => {
    commentLines.push(`>### [${assignee}](https://www.github.com/${assignee})`);
    issues.forEach((issue: string) => {
      commentLines.push(issue);
    });
  });
  return commentLines.join("\n");
}
