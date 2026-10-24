import assert from "node:assert/strict";
import { test } from "node:test";

import { deploy } from "../deploy.mjs";

const sha = "a".repeat(40);
const env = {
  COOLIFY_URL: "https://coolify.test",
  COOLIFY_TOKEN: "private-token",
  COOLIFY_APPLICATION_UUID: "application",
  GITHUB_SHA: sha,
};

function api({ wrongCommit = false, failed = false, pinFailed = false } = {}) {
  const calls = [];
  let pinned = false;
  return {
    calls,
    fetch: async (url, options) => {
      calls.push([String(url), options]);
      if (options.method === "PATCH") {
        pinned = !pinFailed;
        return globalThis.Response.json({ uuid: "application" });
      }
      if (url.pathname.endsWith("/applications/application"))
        return globalThis.Response.json({
          git_repository: "ippo-michi/AnimeTVCut",
          git_branch: "master",
          git_commit_sha: pinned ? sha : "HEAD",
          settings: { is_auto_deploy_enabled: !pinned },
        });
      if (url.pathname.endsWith("/deploy")) {
        assert.equal(pinned, true);
        return globalThis.Response.json({
          deployments: [
            { resource_uuid: "application", deployment_uuid: "deployment" },
          ],
        });
      }
      return globalThis.Response.json({
        status: failed ? "failed" : "finished",
        commit: wrongCommit ? "b".repeat(40) : sha,
      });
    },
  };
}

test("pins the tested commit and disables push deployments before queuing", async () => {
  const mock = api();
  assert.equal((await deploy(env, mock.fetch)).commit, sha);
  assert.deepEqual(JSON.parse(mock.calls[1][1].body), {
    is_auto_deploy_enabled: false,
    git_commit_sha: sha,
  });
});

test("does not queue when the configuration gate cannot be verified", async () => {
  const mock = api({ pinFailed: true });
  await assert.rejects(deploy(env, mock.fetch), /did not confirm/);
  assert.equal(
    mock.calls.some(([url]) => url.includes("/deploy?")),
    false,
  );
});

test("fails for a failed deployment or an unexpected deployed commit", async () => {
  await assert.rejects(deploy(env, api({ failed: true }).fetch), /failed/);
  await assert.rejects(
    deploy(env, api({ wrongCommit: true }).fetch),
    /differs/,
  );
});

test("rejects missing credentials without making network requests", async () => {
  const mock = api();
  await assert.rejects(
    deploy({ ...env, COOLIFY_TOKEN: "" }, mock.fetch),
    /requires/,
  );
  assert.equal(mock.calls.length, 0);
});

test("refuses insecure endpoints and unexpected application ownership", async () => {
  const mock = api();
  await assert.rejects(
    deploy({ ...env, COOLIFY_URL: "http://coolify.test" }, mock.fetch),
    /HTTPS/,
  );
  assert.equal(mock.calls.length, 0);
  let calls = 0;
  await assert.rejects(
    deploy(env, async () => {
      calls += 1;
      return globalThis.Response.json({
        git_repository: "another/repository",
        git_branch: "master",
      });
    }),
    /unexpected repository/,
  );
  assert.equal(calls, 1);
});
