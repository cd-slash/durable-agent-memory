# Bounded private-server access

The trusted TailnetGateway runs Tailscale in userspace-networking mode in a separate Cloudflare Container. Agent-generated code never runs there and never receives an enrollment key. The full coding sandbox remains blocked by its native capability review; this gateway does not lift that block.

Pi exposes three opt-in tools:

| Tool | Operation | Limit |
| --- | --- | --- |
| `tailnet_fetch` | HTTP GET to an approved target/port/path | 8 KiB body, verified TLS, no redirects or custom headers |
| `tailnet_probe` | TCP connection and optional banner | 512 bytes; does not authenticate SSH |
| `tailnet_ssh_check` | Tailscale SSH with fixed marker and `id -un` command | approved user, port 22, 512 bytes, 10 seconds |

SSH check proves authentication. It does not offer arbitrary commands, SSH keys, file transfer or a remote agent shell. Enabling those requires a separate execution/authorization design, particularly for root access. HTTP GET can still trigger effects on poorly designed private services: allow only services you trust. Returned private content is visible to the requesting agent and its configured model provider.

## Identity and network policy

Use a dedicated owner-managed tag, `tag:hm-tailnet-gateway`. Keep gateway SSH permissions limited to a dedicated destination tag and the intended OS user. For example:

```json
{
  "tagOwners": {
    "tag:hm-tailnet-gateway": ["autogroup:owner"],
    "tag:hm-ssh-target": ["autogroup:owner"]
  },
  "grants": [{"src":["tag:hm-tailnet-gateway"],"dst":["tag:hm-ssh-target"],"ip":["tcp:22"]}],
  "ssh": [{"action":"accept","src":["tag:hm-tailnet-gateway"],"dst":["tag:hm-ssh-target"],"users":["approved-user"]}]
}
```

Merge this into your existing policy; never replace it with the example. Tailscale SSH destinations require supported selectors such as tags, rather than literal IPs. Preserve the target's existing tags when assigning a destination tag. The server must already have Tailscale SSH enabled.

Tailscale grants are additive: an existing `* → *` grant also applies to a new gateway tag. This project's current tailnet has such a grant. The gateway's application allowlist limits operations, but its enrollment identity is **not network-isolated by that tailnet policy**. Restrict wildcard grants separately before relying on ACL isolation. No broad existing grant is silently removed.

## Secret provisioning

Configure `TAILSCALE_API_TOKEN` or `TAILSCALE_API_KEY` locally, alongside the existing Cloudflare credential. Never put either into the Worker or source control. Once the dedicated tag exists:

```sh
python3 scripts/provision-tailnet.py --tailnet YOUR_TAILNET
```

This makes one key creation and one Cloudflare secret upload, without printing the key. The enrollment key is reusable for gateway restarts, ephemeral, preauthorized, tagged and expires after one day. Only `TAILSCALE_AUTH_KEY` is stored as Cloudflare `secret_text`; a private metadata-only receipt records its key ID. Upload failure attempts one revocation. Inspect the Tailscale console if revocation is unconfirmed. No background renewal or automatic key minting exists. Expiry prevents new enrollment; it does not itself revoke devices already enrolled. Gateway nodes use memory-only state and are destroyed after each operation.

## Deployment

`wrangler.tailnet.jsonc` defaults to disabled and an empty allowlist. Create a private copy **in the repository root**, ignored by git, and set `TAILNET_ENABLED` to `true` and `TAILNET_TARGETS` to serialized JSON. Use fully qualified `.ts.net` names or Tailscale IPv4 addresses only:

```json
[{"name":"server","host":"server.example.ts.net","ports":[22],"sshUsers":["approved-user"]}]
```

Deploy the private config with Wrangler using authenticated Cloudflare CLI credentials and a Docker-capable builder. Preserve all existing agent/billing bindings, migration tags, limits and counters. Keep `max_instances: 1`, `instance_type: lite`, `scheduling_policy: default`. Never switch this gateway to the arbitrary-code container or expose its localhost SOCKS listener. After activating this configuration, use it for future deployments; the ordinary execution-only config omits the gateway. Do not commit private peer lists or active configuration. Review billing on every deployment.

Owner-only GET `/admin/tailnet/status` reports configuration, running state and bounded journal counts, never keys. Owner-only POST `/admin/tailnet/run` accepts an operation such as:

```json
{"agent":"existing-agent","operationId":"unique-once","target":"server","kind":"ssh","port":22,"user":"approved-user"}
```

Read the owner API token from the existing private token file rather than putting it into command arguments. New multiplayer agents must explicitly allow the selected tailnet tools in their immutable tool policy. Existing agent policies cannot be widened silently.

## Billing and emergency stop

Every operation reserves against the SAME singleton lease and tool/execution/storage budgets used by the prepared coding sandbox. There is one global slot, a 90-second reservation, a fixed 75-second image lifetime, 8 MiB network reservation and 6 MiB storage reservation per attempt. Current ceilings permit at most three attempts/day and ten/month; older execution/storage usage may deny sooner. Actual traffic overhead is not metered by these reservations, so they are **not an invoice cap**. Tailscale control/DERP traffic and Cloudflare retained images, objects, storage and ingress can bill independently.

There is no automatic operation retry. Completed IDs replay their durable result without another container; interrupted IDs are denied. Destruction must finish before the slot is released. Unconfirmed cleanup latches the project stop. Recovery only cleans up; it never resumes an interrupted operation.

The existing red emergency button and `/admin/billing/stop` independently request gateway destruction and persistently block new operations. They do not delete the credential or reset usage. If compromised, revoke the key **and enrolled nodes** in Tailscale; remove the Cloudflare secret as well. Out-of-band endpoint disable remains available in [BILLING.md](BILLING.md).

Local tests use synthetic socket servers and fake provisioning APIs; CI never enrolls a node or runs a paid hosted smoke. A hosted test must inspect headroom first, make a finite explicitly selected operation, verify destruction/slot release, and stop on denial. Host SSH success alone does not prove Cloudflare connectivity.
