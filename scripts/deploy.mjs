import process from "node:process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/** Called only by the production job after checks and playback have succeeded. */
export async function deploy(
  env = process.env,
  fetchImplementation = globalThis.fetch,
  sleep = delay,
) {
  const { COOLIFY_URL, COOLIFY_TOKEN, COOLIFY_APPLICATION_UUID, GITHUB_SHA } =
    env;
  if (
    !COOLIFY_URL ||
    !COOLIFY_TOKEN ||
    !COOLIFY_APPLICATION_UUID ||
    !/^[a-f0-9]{40}$/.test(GITHUB_SHA ?? "")
  )
    throw new Error(
      "Deployment requires COOLIFY_URL, COOLIFY_TOKEN, COOLIFY_APPLICATION_UUID, and a tested GITHUB_SHA.",
    );
  const base = new URL(COOLIFY_URL);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("COOLIFY_URL must be a credential-free HTTPS URL.");
  if (!/^[A-Za-z0-9_-]+$/.test(COOLIFY_APPLICATION_UUID))
    throw new Error("Invalid Coolify application UUID.");
  const api = async (resource, body) => {
    const response = await fetchImplementation(
      new URL(`/api/v1/${resource}`, base),
      {
        method: body === undefined ? "GET" : "PATCH",
        headers: {
          authorization: `Bearer ${COOLIFY_TOKEN}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(`Coolify API request failed (${response.status}).`);
    return response.json();
  };
  const applicationPath = `applications/${COOLIFY_APPLICATION_UUID}`;
  const application = await api(applicationPath);
  if (
    application.git_repository !== "ippo-michi/AnimeTVCut" ||
    application.git_branch !== "master"
  )
    throw new Error("Refusing to deploy an unexpected repository or branch.");
  // Pin the successful revision before queuing: HEAD may have advanced during CI.
  await api(applicationPath, {
    is_auto_deploy_enabled: false,
    git_commit_sha: GITHUB_SHA,
  });
  const pinned = await api(applicationPath);
  if (
    pinned.git_commit_sha !== GITHUB_SHA ||
    pinned.settings?.is_auto_deploy_enabled !== false
  )
    throw new Error(
      "Coolify did not confirm the tested revision and disabled push deployments.",
    );
  const queued = await api(`deploy?uuid=${COOLIFY_APPLICATION_UUID}`);
  const deploymentId = queued.deployments?.find(
    (item) => item.resource_uuid === COOLIFY_APPLICATION_UUID,
  )?.deployment_uuid;
  if (!/^[A-Za-z0-9_-]+$/.test(deploymentId ?? ""))
    throw new Error("Coolify did not queue an identifiable deployment.");
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    const deployment = await api(`deployments/${deploymentId}`);
    if (["failed", "cancelled", "canceled"].includes(deployment.status))
      throw new Error(`Deployment ${deploymentId} ${deployment.status}.`);
    if (deployment.status === "finished") {
      if (deployment.commit !== GITHUB_SHA)
        throw new Error(
          "The deployed revision differs from the revision that passed CI.",
        );
      return { deploymentId, commit: GITHUB_SHA };
    }
    await sleep(5_000);
  }
  throw new Error(
    `Deployment ${deploymentId} did not finish before the deadline.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await deploy();
    process.stdout.write(
      `Deployed tested commit ${result.commit} (${result.deploymentId}).\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Deployment failed."}\n`,
    );
    process.exitCode = 1;
  }
}
