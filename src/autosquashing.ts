import {
  CommitDetails,
  CommitMessage,
  Sha,
} from "shared-github-internals/lib/git";

type AutosquashingMode = null | "fixup" | "squash";

type AutosquashingStep = {
  autosquashMessage: null | CommitMessage;
  shas: Sha[];
};

const getCommitSubjectAndBody = (commitMessage: CommitMessage) => {
  const [subject, ...rest] = commitMessage.split(/(\r\n|\r|\n){2}/u);
  return {
    body: rest
      .map(line => line.trim())
      .filter(line => line !== "")
      .join("\n"),
    subject,
  };
};

const getAutosquashMode = ({
  commitDetails,
  message,
}: {
  commitDetails: CommitDetails;
  message: CommitMessage;
}) => {
  // It's fine, the data is coming from the GitHub API,
  // it won't have a weird shape.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const matches = new RegExp(
    `^(fixup|squash)! (fixup! |squash! )*(${
      getCommitSubjectAndBody(commitDetails.message).subject
    }|${commitDetails.sha}|${commitDetails.sha.substr(7)})$`,
    "u",
  ).exec(getCommitSubjectAndBody(message).subject);
  if (!matches) {
    return null;
  }
  return matches[1] === "fixup" ? "fixup" : "squash";
};

const getNewAutosquashMessage = ({
  commitsDetails,
  message,
  mode,
  step,
}: {
  commitsDetails: CommitDetails[];
  message: CommitMessage;
  mode: AutosquashingMode;
  step: AutosquashingStep;
}) => {
  const previousMessage =
    step.autosquashMessage === null
      ? // We know that the commit details will be found.
        // @ts-ignore
        commitsDetails.find(({ sha }) => sha === step.shas[0]).message
      : step.autosquashMessage;
  return mode === "squash"
    ? `${previousMessage}\n\n${message}`
    : previousMessage;
};

const groupNonAutosquashingSteps = ({
  newStep,
  steps,
}: {
  newStep: AutosquashingStep;
  steps: AutosquashingStep[];
}) =>
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

const getAutosquashingSteps = (commitsDetails: CommitDetails[]) => {
  const alreadyHandledShas = new Set();
  const initialSteps: AutosquashingStep[] = [];

  return commitsDetails.reduce((steps, commitDetails) => {
    if (alreadyHandledShas.has(commitDetails.sha)) {
      return steps;
    }

    alreadyHandledShas.add(commitDetails.sha);

    const initialStep: AutosquashingStep = {
      autosquashMessage: null,
      shas: [commitDetails.sha],
    };

    const newStep = commitsDetails
      .filter(({ sha }) => !alreadyHandledShas.has(sha))
      .reduce((step, { message, sha }) => {
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
      }, initialStep);

    return groupNonAutosquashingSteps({ newStep, steps });
  }, initialSteps);
};

export { AutosquashingStep };

export default getAutosquashingSteps;
