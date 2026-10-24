# Deployment workflow

For implementation tasks, deploy completed changes so the user can test them unless
the user explicitly requests otherwise. Deployment is part of completing the task.

Run the relevant checks, commit and push the tested changes, and wait for GitHub
Actions to finish its checks, playback tests, and promotion to the protected
`production` branch. Coolify deploys only that branch through its GitHub webhook;
keep it separate from `master`, and wait for the Coolify deployment to finish.
Verify the live health endpoint and addon manifest, then report the deployed commit
and public test URL. Follow deployment failures through to resolution.
