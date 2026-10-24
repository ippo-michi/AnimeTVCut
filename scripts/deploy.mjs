import process from "node:process";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = "ippo-michi/AnimeTVCut";

/** Promote the exact successful revision; Coolify watches only this release branch. */
export async function deploy(
  env = process.env,
  fetchImplementation = globalThis.fetch,
  push = async (sha) =>
    exec("git", ["push", "origin", `${sha}:refs/heads/production`]),
) {
  const { GITHUB_TOKEN, GITHUB_SHA, GITHUB_RUN_ID, GITHUB_REPOSITORY } = env;
  if (
    !GITHUB_TOKEN ||
    !/^[a-f0-9]{40}$/.test(GITHUB_SHA ?? "") ||
    !/^\d+$/.test(GITHUB_RUN_ID ?? "") ||
    GITHUB_REPOSITORY !== repository
  )
    throw new Error(
      "Production promotion requires this repository's token, tested GITHUB_SHA, and GITHUB_RUN_ID.",
    );
  const api = async (path) => {
    const response = await fetchImplementation(
      `https://api.github.com/repos/${repository}/${path}`,
      {
        headers: {
          authorization: `Bearer ${GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(
        `GitHub promotion preflight failed (${response.status}).`,
      );
    return response.json();
  };
  const run = await api(`actions/runs/${GITHUB_RUN_ID}`);
  if (
    run.head_sha !== GITHUB_SHA ||
    run.head_branch !== "master" ||
    run.event !== "push" ||
    run.path !== ".github/workflows/ci.yml" ||
    run.repository?.full_name !== repository
  )
    throw new Error(
      "Refusing to promote a revision outside the trusted master CI workflow.",
    );
  const jobs = await api(`actions/runs/${GITHUB_RUN_ID}/jobs?per_page=100`);
  for (const name of ["checks", "playback"]) {
    const matches = jobs.jobs?.filter((job) => job.name === name) ?? [];
    if (
      matches.length !== 1 ||
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success"
    )
      throw new Error(
        `Production promotion requires a successful ${name} job.`,
      );
  }
  // A normal git push enforces both fast-forward history and branch protection.
  // The repository-scoped deploy key also supports commits that change workflows.
  await push(GITHUB_SHA);
  const ref = await api("git/ref/heads/production");
  if (ref.object?.sha !== GITHUB_SHA)
    throw new Error(
      "The production branch does not match the tested revision.",
    );
  return { commit: GITHUB_SHA, branch: "production" };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await deploy();
    process.stdout.write(
      `Promoted tested commit ${result.commit} to ${result.branch}; Coolify receives the deployment webhook.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Production promotion failed."}\n`,
    );
    process.exitCode = 1;
  }
}
