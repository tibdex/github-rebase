import { flatten } from "lodash";
import {
  CommitDetails,
  CommitMessage,
  Reference,
} from "shared-github-internals/lib/git";
import { getReferenceCommitsFromGitRepo } from "shared-github-internals/lib/tests/git";

import getAutosquashingSteps, { AutosquashingStep } from "./autosquashing";
import { createGitRepoAndRebase } from "./tests-utils";

const getCommit = ({
  commitCounts,
  message,
  position,
}: {
  commitCounts: number;
  message: CommitMessage;
  position: number;
}) => ({
  lines: new Array(commitCounts - 1)
    .fill("initial")
    .map((value, index) => (index < position ? String(index) : value)),
  message,
});

const commitsDetailsToInitialState = ({
  commitsDetails,
  reference,
}: {
  commitsDetails: CommitDetails[];
  reference: Reference;
}) => {
  const commitCounts = commitsDetails.length + 1;
  return {
    initialCommit: getCommit({ commitCounts, message: "initial", position: 0 }),
    refsCommits: {
      [reference]: commitsDetails.map(({ message }, index) =>
        getCommit({ commitCounts, message, position: index + 1 }),
      ),
    },
  };
};

const autosquashingStepsToCommitMessages = ({
  commitsDetails,
  steps,
}: {
  commitsDetails: CommitDetails[];
  steps: AutosquashingStep[];
}) =>
  flatten(
    steps.map(
      ({ autosquashMessage, shas }) =>
        autosquashMessage === null
          ? shas.map(
              stepSha =>
                // @ts-ignore We know that the commit details will be found.
                commitsDetails.find(({ sha }) => sha === stepSha).message,
            )
          : autosquashMessage,
    ),
  );

test.each([
  ["nothing to do with", ["a", "fixup! b"]],
  ["simple fixup", ["a", "b", "fixup! a"]],
  [
    "simple squash",
    ["a\n\nSome details", "b", "squash! a\n\nSome more details"],
  ],
  [
    "lot of things to do",
    [
      "a\n\nSome details\non two lines",
      "b",
      "fixup! a\n\nSome unnecessary details",
      "c",
      "d",
      "squash! fixup! a\n\nAgain some more details",
      "squash! b",
      "squash! a\n\nLast fix",
    ],
  ],
])("%s", async (tmp, commitMessages) => {
  const reference = "feature";
  const commitsDetails = commitMessages.map(
    (message: CommitMessage, index: number) => ({
      message,
      sha: new Array(7).fill(index).join(""),
    }),
  );
  const directory = await createGitRepoAndRebase({
    initialState: commitsDetailsToInitialState({
      commitsDetails,
      reference,
    }),
    reference,
  });
  const expectedCommits = await getReferenceCommitsFromGitRepo({
    directory,
    reference,
  });
  const expectedMessages = expectedCommits
    .slice(1)
    .map(({ message }) => message);
  expect({ commitsDetails, expectedMessages }).toMatchSnapshot();
  const steps = getAutosquashingSteps(commitsDetails);
  expect(autosquashingStepsToCommitMessages({ commitsDetails, steps })).toEqual(
    expectedMessages,
  );
});
