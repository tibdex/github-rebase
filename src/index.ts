import * as Octokit from "@octokit/rest";
import * as createDebug from "debug";
import cherryPick from "github-cherry-pick";
import {
  CommitDetails,
  fetchCommitsDetails,
  fetchReferenceSha,
  PullRequestNumber,
  Reference,
  RepoName,
  RepoOwner,
  Sha,
  updateReference,
  withTemporaryReference,
} from "shared-github-internals/lib/git";

import getAutosquashingSteps, { AutosquashingStep } from "./autosquashing";

const debug = createDebug("github-rebase");

const needAutosquashing = async ({
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}) => {
  const commitsDetails = await fetchCommitsDetails({
    octokit,
    owner,
    pullRequestNumber,
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
}: {
  commitsDetails: CommitDetails[];
  octokit: Octokit;
  owner: RepoOwner;
  parent: Sha;
  ref: Reference;
  refSha: Sha;
  repo: RepoName;
  step: AutosquashingStep;
}) => {
  // @ts-ignore We know that the commit details will be found.
  const { author, committer } = commitsDetails.find(
    ({ sha: commitSha }) => commitSha === step.shas[0],
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
    // @ts-ignore We know that the message is not null.
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

const performRebase = async ({
  commitsDetails,
  octokit,
  owner,
  ref,
  repo,
}: {
  commitsDetails: CommitDetails[];
  octokit: Octokit;
  owner: RepoOwner;
  ref: Reference;
  repo: RepoName;
}) => {
  const initialRefSha = await fetchReferenceSha({
    octokit,
    owner,
    ref,
    repo,
  });
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
    Promise.resolve(initialRefSha),
  );
  return newRefSha;
};

const checkSameHead = async ({
  octokit,
  owner,
  ref,
  repo,
  sha: expectedSha,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  ref: Reference;
  repo: RepoName;
  sha: Sha;
}) => {
  const actualSha = await fetchReferenceSha({ octokit, owner, ref, repo });
  if (actualSha !== expectedSha) {
    throw new Error(
      [
        `Rebase aborted because the head branch changed.`,
        `The current SHA of ${ref} is ${actualSha} but it was expected to still be ${expectedSha}.`,
      ].join("\n"),
    );
  }
};

// eslint-disable-next-line max-lines-per-function
const rebasePullRequest = async ({
  // Should only be used in tests.
  _intercept = () => Promise.resolve(),
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  _intercept?: ({ initialHeadSha }: { initialHeadSha: Sha }) => Promise<void>;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}): Promise<Sha> => {
  debug("starting", { pullRequestNumber, owner, repo });

  const {
    data: {
      base: { ref: baseRef },
      head: { ref: headRef, sha: initialHeadSha },
    },
  } = await octokit.pullRequests.get({
    number: pullRequestNumber,
    owner,
    repo,
  });
  // The SHA given by GitHub for the base branch is not always up to date.
  // A request is made to fetch the actual one.
  const baseInitialSha = await fetchReferenceSha({
    octokit,
    owner,
    ref: baseRef,
    repo,
  });
  const commitsDetails = await fetchCommitsDetails({
    octokit,
    owner,
    pullRequestNumber,
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
    ref: `rebase-pull-request-${pullRequestNumber}`,
    repo,
    sha: baseInitialSha,
  });
};

export { needAutosquashing };

export default rebasePullRequest;
