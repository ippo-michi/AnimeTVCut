import assert from "node:assert/strict";
import { test } from "node:test";

import { deploy } from "../deploy.mjs";

const sha = "a".repeat(40);
const repository = "ippo-michi/AnimeTVCut";
const env = {
  GITHUB_TOKEN: "private-token",
  GITHUB_SHA: sha,
  GITHUB_RUN_ID: "123",
  GITHUB_REPOSITORY: repository,
};

function api({
  failed = false,
  wrongCommit = false,
  pullRequest = false,
  wrongRef = false,
} = {}) {
  const pushed = [];
  return {
    pushed,
    push: async (commit) => {
      pushed.push(commit);
    },
    fetch: async (input) => {
      const url = new globalThis.URL(input);
      if (url.pathname.endsWith("/jobs"))
        return globalThis.Response.json({
          jobs: ["checks", "playback"].map((name) => ({
            name,
            status: "completed",
            conclusion: failed ? "failure" : "success",
          })),
        });
      if (url.pathname.endsWith("/production"))
        return globalThis.Response.json({
          object: { sha: wrongRef ? "b".repeat(40) : sha },
        });
      return globalThis.Response.json({
        head_sha: wrongCommit ? "b".repeat(40) : sha,
        head_branch: "master",
        event: pullRequest ? "pull_request" : "push",
        path: ".github/workflows/ci.yml",
        repository: { full_name: repository },
      });
    },
  };
}

test("promotes only the revision whose checks and playback succeeded", async () => {
  const mock = api();
  assert.deepEqual(await deploy(env, mock.fetch, mock.push), {
    commit: sha,
    branch: "production",
  });
  assert.deepEqual(mock.pushed, [sha]);
});

test("does not push when checks fail or the workflow revision differs", async () => {
  for (const options of [
    { failed: true },
    { wrongCommit: true },
    { pullRequest: true },
  ]) {
    const mock = api(options);
    await assert.rejects(deploy(env, mock.fetch, mock.push));
    assert.deepEqual(mock.pushed, []);
  }
});

test("requires credentials and the trusted repository before making requests", async () => {
  for (const invalid of [
    { ...env, GITHUB_TOKEN: "" },
    { ...env, GITHUB_REPOSITORY: "another/repository" },
  ]) {
    const mock = api();
    await assert.rejects(deploy(invalid, mock.fetch, mock.push), /requires/);
    assert.deepEqual(mock.pushed, []);
  }
});

test("reports a protected-branch or non-fast-forward rejection", async () => {
  const mock = api();
  await assert.rejects(
    deploy(env, mock.fetch, async () => {
      throw new Error("Protected branch rejected");
    }),
    /Protected branch/,
  );
});

test("verifies the promoted branch still identifies the tested commit", async () => {
  const mock = api({ wrongRef: true });
  await assert.rejects(deploy(env, mock.fetch, mock.push), /does not match/);
});
