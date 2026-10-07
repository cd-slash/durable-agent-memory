## Change
Prepare an opt-in Linux coding sandbox using current native Cloudflare Container APIs. No container application is deployed or enabled by this change. Separate owner approval and Docker-capable image build are required for activation.

## Billable paths
Container CPU, provisioned memory/disk, HTTP egress, one SQLite sandbox object, bounded checkpoints/results, coordinator admission and cleanup alarms. Existing AI/tool/turn/request/storage gates remain. A ten-minute image build/test job uses GitHub public runners only, skips private repositories and has no Cloudflare credentials/deployment or artifact upload. Container startup never performs inference.

## Worst-case bounds
Proposed global lease: one running container, 90 reserved seconds per attempt, three attempts/day and ten/month (270/900 seconds). Lite is 1/16 vCPU, 256 MiB, 2 GB disk. Each attempt also consumes existing executions/tools and reserves 6 MiB storage; existing storage may deny earlier. Network reserves 8 MiB per attempt, at most 16 public allowlisted requests and 2 MiB per response. Checkpoint cap 2 MiB including Git metadata, excludes dependency/cache directories. No snapshots/R2/new external store. Commands max 30 seconds, output 8 KiB combined. Image PID 1 exits after 75 seconds. Provisioning delays and failed platform cleanup can exceed estimates; these are not invoice caps.

## Failure and retry
No automatic execution retry or expired-lease reuse. Durable operation journal prevents duplicate effects after restart. Failed attempts are charged/reserved. Unconfirmed destroy keeps the global slot occupied and latches stop. One durable cleanup alarm, no self-rescheduling loops. Startup restoration and commands run within one fixed deadline; read/stream caps prevent unbounded buffering. Emergency cancellation may lose uncheckpointed changes.

## Emergency stop
Existing stop latches admission first, requests singleton container destruction independently of Pi abort, and retains the slot until destruction is confirmed. Status remains owner-readable while stopped. Repeated explicit stop can retry cleanup. Out-of-band endpoint disable remains necessary for abusive ingress or unavailable Worker.

## Validation
Executed: 69 unit tests including 18 sandbox tests and four actual Python checkpoint tests, typecheck, billing check, guarded Worker dry-run; real local workerd workspace, restart recovery, JSONL T3 bridge and multiplayer suites all passed. Sandbox config validation passed lifecycle declarations after retaining migrations; its full dry-run is blocked locally by missing Docker. Opt-in activation command was tested without confirmation and failed before deployment. Further image CI is required before activation. Hosted container tests are not enabled in CI. Record final executed checks and limits in sandbox documentation before commit.

## Residual risks
Cloudflare beta behavior, destroy latency/failure, alarm timing, retained storage and ingress remain billable. Docker is unavailable on this host; image and native container transport need separately approved finite hosted verification. Lite capacity and small durable checkpoints restrict large repositories/builds. Package supply-chain code can access files in its own isolated workspace; no credentials or platform bindings enter the container. Public registry/Git allowlist is not a data-loss prevention system.
