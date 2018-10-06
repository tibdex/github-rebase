// @flow strict

import type { Github } from "@octokit/rest";
import createDebug from "debug";
import cherryPick from "github-cherry-pick";
import {
  type PullRequestNumber,
  type RepoName,
  type RepoOwner,
  type Sha,
  fetchCommitsDetails,
  fetchReferenceSha,
  updateReference,
  withTemporaryReference,
} from "shared-github-internals/lib/git";

import { name as packageName } from "../package";

import getAutosquashingSteps from "./autosquashing";

const needAutosquashing = async ({
  number,
  octokit,
  owner,
  repo,
}: {
  number: PullRequestNumber,
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
}) => {
  const commitsDetails = await fetchCommitsDetails({
    number,
    octokit,
    owner,
    repo,
  });
  const steps = getAutosquashingSteps(commitsDetails);
  return steps.length > 1 || (steps[0] && steps[0].autosquashMessage !== null);
};

const autosquash = async ({
  commitsDetails,
  octokit,
  owner,
  parent,
  ref,
  refSha,
  repo,
  step,
}) => {
  const { author, committer } = commitsDetails.find(
    ({ sha }) => sha === step.shas[0]
  );
  const {
    data: {
      tree: { sha: tree },
    },
  } = await octokit.gitdata.getCommit({ commit_sha: refSha, owner, repo });
  const {
    data: { sha },
  } = await octokit.gitdata.createCommit({
    author,
    committer,
    message: step.autosquashMessage,
    owner,
    parents: [parent],
    repo,
    tree,
  });
  await updateReference({
    // Autosquashing is not a fast-forward operation.
    force: true,
    octokit,
    owner,
    ref,
    repo,
    sha,
  });
  return sha;
};

const performRebase = async ({ commitsDetails, octokit, owner, ref, repo }) => {
  const initialRefSha = await fetchReferenceSha({
    octokit,
    owner,
    ref,
    repo,
  });
  // $FlowFixMe Flow wronlgy believes that `commitsDetails` is a promise.
  const newRefSha = await getAutosquashingSteps(commitsDetails).reduce(
    async (promise, step) => {
      const parent = await promise;

      const sha = await cherryPick({
        commits: step.shas,
        head: ref,
        octokit,
        owner,
        repo,
      });

      if (step.autosquashMessage === null) {
        return sha;
      }

      return autosquash({
        commitsDetails,
        octokit,
        owner,
        parent,
        ref,
        refSha: sha,
        repo,
        step,
      });
    },
    Promise.resolve(initialRefSha)
  );
  return newRefSha;
};

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
  // $FlowFixMe an incomprehensible error is thrown here.
  const commitsDetails = await fetchCommitsDetails({
    number,
    octokit,
    owner,
    repo,
  });
  debug("commits details fetched", {
    baseInitialSha,
    commitsDetails,
    headRef,
    initialHeadSha,
  });
  await _intercept({ initialHeadSha });
  return withTemporaryReference({
    action: async temporaryRef => {
      debug({ temporaryRef });
      const newSha = await performRebase({
        commitsDetails,
        octokit,
        owner,
        ref: temporaryRef,
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

export { needAutosquashing };

export default rebasePullRequest;
