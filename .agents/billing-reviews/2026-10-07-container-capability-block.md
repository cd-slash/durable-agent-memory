## Change
Block activation of the unverified native Cloudflare coding sandbox after discovering official beta API constraints: durable_object scheduling grants all exec processes root capabilities, user must be numeric uid:gid, and startup environment is not inherited by exec except PATH. Correct the adapter syntax/environment and documentation. Research Tailscale userspace connectivity without enabling it.

## Billable paths
Only the prepared sandbox deployment/start admission is affected. CLI, coordinator and native run endpoint reject activation independently of environment flags or approval arguments. Existing live JavaScript/Pi/memory deployment is untouched. No Tailscale node, auth key, secret, sandbox or hosted test is created.

## Worst-case bounds
Zero new container starts through these blocked paths; existing quotas remain unchanged. Read-only documentation retrieval is finite. Fixed PID1 lifetime and non-root file permissions can no longer be claimed as trusted protections under durable_object scheduling. A redesign must use a documented isolation model and external lifetime controls before any activation approval.

## Failure and retry
Activation fails before Docker/Cloudflare effects, even with an approval argument. No retries, recovery execution or new alarms. Existing durable global lease and emergency stop remain. A caller cannot lift the block by setting SANDBOX_ENABLED alone.

## Emergency stop
Existing global owner stop and endpoint disable remain available. This change adds prevention, without resuming, clearing counters or deploying changes to the existing service.

## Validation
Passed billing review, typecheck, 70 unit tests including explicit CLI attempts with/without confirmation, and guarded Worker dry-run. Owner status now reports the activation block; native execution/coordinator cannot override it with a flag. Documentation claims are corrected against official cloudflare-docs commit 54a7e6e, Container.exec documentation. Tailscale docs establish userspace SOCKS/HTTP mode; native connectivity remains untested.

## Residual risks
Docker non-root tests do not reproduce deployed durable_object capabilities. Userspace Tailscale requires reviewed outbound connectivity and narrowly scoped tailnet identity; direct private network membership can expose peer servers and credentials to arbitrary agent code. No claim of demonstrated Cloudflare Tailscale connectivity. Default scheduling or a separate tailnet gateway must be investigated before lifting this source-level block; cost and security review plus explicit owner approval remain required.
