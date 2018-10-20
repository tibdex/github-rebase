import * as Octokit from "@octokit/rest";
import {
  fetchReferenceSha,
  PullRequestNumber,
  RepoName,
  RepoOwner,
  Sha,
  updateReference,
} from "shared-github-internals/lib/git";
import { createTestContext } from "shared-github-internals/lib/tests/context";
import {
  CommandDirectory,
  createCommitFromLinesAndMessage,
  createPullRequest,
  createReferences,
  DeleteReferences,
  fetchReferenceCommits,
  fetchReferenceCommitsFromSha,
  getReferenceCommitsFromGitRepo,
  RefsDetails,
} from "shared-github-internals/lib/tests/git";

import rebasePullRequest, { needAutosquashing } from ".";
import { createGitRepoAndRebase } from "./tests-utils";

const [initial, feature1st, feature2nd, master1st, master2nd] = [
  "initial",
  "feature 1st",
  "feature 2nd",
  "master 1st",
  "master 2nd",
];

let octokit: Octokit;
let owner: RepoOwner;
let repo: RepoName;

beforeAll(() => {
  ({ octokit, owner, repo } = createTestContext());
});

describe.each([
  [
    "nominal behavior",
    () => ({
      initialCommit: {
        lines: [initial, initial, initial, initial],
        message: initial,
      },
      refsCommits: {
        feature: [
          {
            lines: [feature1st, initial, initial, initial],
            message: feature1st,
          },
          {
            lines: [feature1st, feature2nd, initial, initial],
            message: feature2nd,
          },
        ],
        master: [
          {
            lines: [initial, initial, master1st, initial],
            message: master1st,
          },
          {
            lines: [initial, initial, master1st, master2nd],
            message: master2nd,
          },
        ],
      },
    }),
  ],
  [
    "autosquashing",
    () => {
      const fixup1st = `fixup! ${feature1st}`;
      const squash2nd = `squash! ${feature2nd}`;

      return {
        initialCommit: {
          lines: [initial, initial, initial, initial],
          message: initial,
        },
        refsCommits: {
          feature: [
            {
              lines: [feature1st, initial, initial, initial],
              message: feature1st,
            },
            {
              lines: [feature1st, feature2nd, initial, initial],
              message: feature2nd,
            },
            {
              lines: [feature1st, feature2nd, fixup1st, initial],
              message: `${fixup1st}\n\nSome unnecessary details`,
            },
            {
              lines: [feature1st, feature2nd, fixup1st, squash2nd],
              message: `${squash2nd}\n\nSome interesting details`,
            },
          ],
          master: [],
        },
      };
    },
  ],
])("%s", (tmp, getProperties) => {
  const initialState = getProperties();

  let deleteReferences: DeleteReferences;
  let directory: CommandDirectory;
  let pullRequestNumber: PullRequestNumber;
  let refsDetails: RefsDetails;
  let sha: Sha;

  beforeAll(async () => {
    ({ deleteReferences, refsDetails } = await createReferences({
      octokit,
      owner,
      repo,
      state: initialState,
    }));
    pullRequestNumber = await createPullRequest({
      base: refsDetails.master.ref,
      head: refsDetails.feature.ref,
      octokit,
      owner,
      repo,
    });
    sha = await rebasePullRequest({
      octokit,
      owner,
      pullRequestNumber,
      repo,
    });
    directory = await createGitRepoAndRebase({
      initialState,
      reference: "feature",
    });
  }, 30000);

  afterAll(async () => {
    await deleteReferences();
  });

  test("autosquashing detection", async () => {
    const autosquashingNeeded = await needAutosquashing({
      octokit,
      owner,
      pullRequestNumber,
      repo,
    });
    expect({ autosquashingNeeded, initialState }).toMatchSnapshot();
  });

  test("returned sha is the actual feature ref sha", async () => {
    const actualRefSha = await fetchReferenceSha({
      octokit,
      owner,
      ref: refsDetails.feature.ref,
      repo,
    });
    expect(actualRefSha).toBe(sha);
  });

  test("commits on the feature ref are the expected ones", async () => {
    const expectedCommits = await getReferenceCommitsFromGitRepo({
      directory,
      reference: "feature",
    });
    expect({ commits: expectedCommits, initialState }).toMatchSnapshot();
    const actualCommits = await fetchReferenceCommitsFromSha({
      octokit,
      owner,
      repo,
      sha,
    });
    expect(actualCommits).toEqual(expectedCommits);
  });
});

describe("atomicity", () => {
  describe.each([
    [
      "one of the commits cannot be cherry-picked",
      () => {
        const [initialCommit, feature1stCommit] = [
          {
            lines: [initial, initial],
            message: initial,
          },
          {
            lines: [feature1st, initial],
            message: feature1st,
          },
        ];

        return {
          errorRegex: /Merge conflict/u,
          expectedFeatureCommits: [initialCommit, feature1stCommit],
          initialState: {
            initialCommit,
            refsCommits: {
              feature: [feature1stCommit],
              master: [
                {
                  lines: [initial, master1st],
                  message: master1st,
                },
                {
                  lines: [master2nd, master1st],
                  message: master2nd,
                },
              ],
            },
          },
        };
      },
    ],
    [
      "the head reference changed",
      () => {
        const [initialCommit, feature1stCommit, feature2ndCommit] = [
          {
            lines: [initial, initial],
            message: initial,
          },
          {
            lines: [feature1st, initial],
            message: feature1st,
          },
          {
            lines: [feature1st, feature2nd],
            message: feature2nd,
          },
        ];

        return {
          errorRegex: /Rebase aborted because the head branch changed/u,
          expectedFeatureCommits: [
            initialCommit,
            feature1stCommit,
            feature2ndCommit,
          ],
          getIntercept: (refsDetails: RefsDetails) => async ({
            initialHeadSha,
          }: {
            initialHeadSha: Sha;
          }) => {
            const newCommit = await createCommitFromLinesAndMessage({
              commit: feature2ndCommit,
              octokit,
              owner,
              parent: initialHeadSha,
              repo,
            });
            await updateReference({
              force: false,
              octokit,
              owner,
              ref: refsDetails.feature.ref,
              repo,
              sha: newCommit,
            });
          },
          initialState: {
            initialCommit,
            refsCommits: {
              feature: [feature1stCommit],
              master: [
                {
                  lines: [initial, master1st],
                  message: master1st,
                },
              ],
            },
          },
        };
      },
    ],
  ])("%s", (tmp, getProperties) => {
    const {
      errorRegex,
      expectedFeatureCommits,
      getIntercept,
      initialState,
    } = getProperties();

    let deleteReferences: DeleteReferences;
    let pullRequestNumber: PullRequestNumber;
    let refsDetails: RefsDetails;

    beforeAll(async () => {
      ({ deleteReferences, refsDetails } = await createReferences({
        octokit,
        owner,
        repo,
        state: initialState,
      }));
      pullRequestNumber = await createPullRequest({
        base: refsDetails.master.ref,
        head: refsDetails.feature.ref,
        octokit,
        owner,
        repo,
      });
    }, 20000);

    afterAll(async () => {
      await deleteReferences();
    });

    test(
      "whole operation aborted",
      async () => {
        await expect(
          rebasePullRequest({
            // eslint-disable-next-line no-undefined
            _intercept: getIntercept ? getIntercept(refsDetails) : undefined,
            octokit,
            owner,
            pullRequestNumber,
            repo,
          }),
        ).rejects.toThrow(errorRegex);
        const featureCommits = await fetchReferenceCommits({
          octokit,
          owner,
          ref: refsDetails.feature.ref,
          repo,
        });
        expect(featureCommits).toEqual(expectedFeatureCommits);
      },
      20000,
    );
  });
});
