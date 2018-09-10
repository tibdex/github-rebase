// @flow strict

import type { Github } from "@octokit/rest";
import createDebug from "debug";
import cherryPick from "github-cherry-pick";
import {
  type PullRequestNumber,
  type RepoName,
  type RepoOwner,
  type Sha,
  fetchCommits,
  fetchReferenceSha,
  updateReference,
  withTemporaryReference,
} from "shared-github-internals/lib/git";

import { name as packageName } from "../package";

const checkSameHead = async ({
  octokit,
  owner,
  ref,
  repo,
  sha: expectedSha,
}) => {
  const actualSha = await fetchReferenceSha({ octokit, owner, ref, repo });
  if (actualSha !== expectedSha) {
    throw new Error(
      [
        `Rebase aborted because the head branch changed.`,
        `The current SHA of ${ref} is ${actualSha} but it was expected to still be ${expectedSha}.`,
      ].join("\n")
    );
  }
};

// eslint-disable-next-line max-lines-per-function
const rebasePullRequest = async ({
  // Should only be used in tests.
  _intercept = () => Promise.resolve(),
  number,
  octokit,
  owner,
  repo,
}: {
  _intercept?: ({ initialHeadSha: Sha }) => Promise<void>,
  number: PullRequestNumber,
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
}): Promise<Sha> => {
  const debug = createDebug(packageName);
  debug("starting", { number, owner, repo });

  const {
    data: {
      base: { ref: baseRef },
      head: { ref: headRef, sha: initialHeadSha },
    },
  } = await octokit.pullRequests.get({ number, owner, repo });
  // The SHA given by GitHub for the base branch is not always up to date.
  // A request is made to fetch the actual one.
  const baseInitialSha = await fetchReferenceSha({
    octokit,
    owner,
    ref: baseRef,
    repo,
  });
  const commits = await fetchCommits({ number, octokit, owner, repo });
  debug("commits", {
    baseInitialSha,
    commits,
    headRef,
    initialHeadSha,
  });
  await _intercept({ initialHeadSha });
  return withTemporaryReference({
    action: async temporaryRef => {
      debug({ temporaryRef });
      const newSha = await cherryPick({
        commits,
        head: temporaryRef,
        octokit,
        owner,
        repo,
      });
      await checkSameHead({
        octokit,
        owner,
        ref: headRef,
        repo,
        sha: initialHeadSha,
      });
      debug("updating reference with new SHA", newSha);
      await updateReference({
        // Rebase operations are not fast-forwards.
        force: true,
        octokit,
        owner,
        ref: headRef,
        repo,
        sha: newSha,
      });
      debug("reference updated");
      return newSha;
    },
    octokit,
    owner,
    ref: `rebase-pull-request-${number}`,
    repo,
    sha: baseInitialSha,
  });
};

export { rebasePullRequest };
