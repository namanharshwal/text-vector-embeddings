export function shouldRedactPrivateRepoComments(repositoryIsPrivate: boolean, redactPrivateRepoComments?: boolean): boolean {
  return repositoryIsPrivate && redactPrivateRepoComments === true;
}
