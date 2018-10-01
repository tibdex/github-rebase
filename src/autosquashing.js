// @flow strict

import { type CommitDetails } from "shared-github-internals/lib/git";

const getCommitSubjectAndBody = commitMessage => {
  const [subject, ...rest] = commitMessage.split(/(\r\n|\r|\n){2}/u);
  return {
    body: rest
      .map(line => line.trim())
      .filter(line => line !== "")
      .join("\n"),
    subject,
  };
};

const getAutosquashMode = ({ commitDetails, message }) => {
  // It's fine, the data is coming from the GitHub API,
  // it won't have a weird shape.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const matches = new RegExp(
    `^(fixup|squash)! (fixup! |squash! )*(${
      getCommitSubjectAndBody(commitDetails.message).subject
    }|${commitDetails.sha}|${commitDetails.sha.substr(7)})$`,
    "u"
  ).exec(getCommitSubjectAndBody(message).subject);
  return matches ? matches[1] : null;
};

const getNewAutosquashMessage = ({ commitsDetails, message, mode, step }) => {
  const previousMessage =
    step.autosquashMessage === null
      ? ((commitsDetails.find(
          ({ sha }) => sha === step.shas[0]
          // $FlowFixMe force type because Flow wrongly believe `find` can return `null` here.
        ): any): CommitDetails).message
      : step.autosquashMessage;
  return mode === "squash"
    ? `${previousMessage}\n\n${message}`
    : previousMessage;
};

const groupNonAutosquashingSteps = ({ newStep, steps }) =>
  newStep.autosquashMessage === null &&
  steps.length > 0 &&
  steps[steps.length - 1].autosquashMessage === null
    ? [
        ...steps.slice(0, -1),
        {
          autosquashMessage: null,
          shas: [...steps[steps.length - 1].shas, ...newStep.shas],
        },
      ]
    : [...steps, newStep];

const getAutosquashingSteps = (commitsDetails: Array<CommitDetails>) => {
  const alreadyHandledShas = new Set();

  return commitsDetails.reduce((steps, commitDetails) => {
    if (alreadyHandledShas.has(commitDetails.sha)) {
      return steps;
    }

    alreadyHandledShas.add(commitDetails.sha);

    const newStep = commitsDetails
      .filter(({ sha }) => !alreadyHandledShas.has(sha))
      .reduce(
        (step, { message, sha }) => {
          const mode = getAutosquashMode({ commitDetails, message });
          if (mode === null) {
            return step;
          }
          alreadyHandledShas.add(sha);
          return {
            autosquashMessage: getNewAutosquashMessage({
              commitsDetails,
              message,
              mode,
              step,
            }),
            shas: [...step.shas, sha],
          };
        },
        {
          autosquashMessage: null,
          shas: [commitDetails.sha],
        }
      );

    return groupNonAutosquashingSteps({ newStep, steps });
  }, []);
};

export default getAutosquashingSteps;
