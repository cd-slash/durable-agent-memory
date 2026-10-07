## Change
Add a manually gated Docker-capable GitHub deployment runner and record successful image CI. No deployment is invoked or credentials configured by this change. Owner cost approval remains pending.

## Billable paths
An explicitly approved manual workflow can build/upload the image and deploy the new container application; normal check CI still cannot deploy. Cloudflare credentials are available only to the deployment step via an environment secret. GitHub public runners are free for this public repository; skip private repositories to avoid adding paid runner usage.

## Worst-case bounds
One manual job, ten-minute runner timeout, only main branch, one deployment command, no inference/execution smoke or automatic retries. Current container/AI/storage/ingress quotas remain unchanged. A serialized deploy concurrency group avoids competing deployments. New application stays scale-to-zero until an admitted shell tool is explicitly called.

## Failure and retry
Missing secret fails before deployment; cancellation/timeout never resubmits. Partial image/deployment artifacts may need owner inspection. Deployment does not clear usage or resume a latched stop. Existing namespace migrations are retained; future disable must retain them.

## Emergency stop
Existing owner stop, container destruction and out-of-band endpoint disable remain. Runner only deploys the reviewed sandbox config and checks its policy first. No rollback to a guardless build.

## Validation
First pushed sandbox commit passed all check CI and its Docker image job (run 37615068923): Node/npm/Python/Git, UID 1000 workspace writes and checkpoint tests. Local checks passed 69 tests, typecheck, billing review, guarded dry-run and four workerd suites. New workflow is manual only and has no configured Cloudflare environment secret or dispatch. Validate its event/ref/approval/secret/timeout guards before publishing.

## Residual risks
Deployment authorization and a Cloudflare token with Containers permissions are still required. GitHub environment secrets widen the credential trust boundary; configure only after explicit owner approval of that deployment method, scope the token narrowly and never print it. A Docker-capable deployment workflow solves this host's absent Docker without installing an unsafe privileged daemon. Native Cloudflare transport/network/recovery remains unverified until the finite separately approved smoke; retained resources and ingress remain billable.
