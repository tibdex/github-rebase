// @flow strict

import { type Reference } from "shared-github-internals/lib/git";
import {
  type CommandDirectory,
  type RepoState,
  createGitRepo,
  executeGitCommand,
} from "shared-github-internals/lib/tests/git";

const createGitRepoAndRebase = async ({
  initialState,
  reference,
}: {
  initialState: RepoState,
  reference: Reference,
}): Promise<CommandDirectory> => {
  const directory = await createGitRepo(initialState);
  await executeGitCommand({
    args: ["rebase", "--autosquash", "--interactive", "master"],
    directory,
    // See https://stackoverflow.com/a/29094904
    env: { GIT_EDITOR: ":", GIT_SEQUENCE_EDITOR: ":" },
    reference,
  });
  return directory;
};

export { createGitRepoAndRebase };
