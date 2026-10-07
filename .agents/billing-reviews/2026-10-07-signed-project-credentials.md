## Change

Reject invalid project credentials at the Worker boundary using HMAC before a coordinator lookup. Add a thirty-day credential lifetime and owner-controlled rotation of an existing member identity. Document completed multiplayer validation.

## Billable paths

Native crypto verification adds bounded Worker CPU for unauthenticated traffic while removing random-token SQLite lookup amplification. Valid signed credentials still consult the coordinator for authorization/revocation. Owner rotation updates one existing bounded member row, reserved under the unchanged storage policy. No new model calls or infrastructure.

## Worst-case bounds

Credential length at most 256 bytes, one HMAC verify and small JSON validation per request. All existing global quotas and project/member/agent/task limits remain unchanged. Invalid signatures and expiration never contact a DO. Existing member rotation preserves its id and the eight-member ceiling. One hosted read-only validation/rotation is finite; no further paid inference tests.

## Failure and retry

Signature/format/expiration failures reject before namespace lookup. Key rotation invalidates all issued project tokens. Credential rotation invalidates the previous hash immediately. There are no automatic refresh, renewal or retries. The earlier two-turn hosted collaboration smoke succeeded with six AI calls and 679 reserved neurons; it will not be repeated.

## Emergency stop

Owner stop/status/resume bypasses project credential validation and remains reachable. Owner member revocation also works while globally stopped, without launching work. Global limits and reservations are not reset.

## Validation

New local tests verify valid signatures, tampering, expiry, owner-key rotation and stable member renewal. Completed: 51 unit tests, typecheck and guarded deployment dry-run passed; real workerd multiplayer/restart/permission/stop and T3 bridge suites passed. Hosted read-only verification will confirm freshly rotated scoped access and old/random-token rejection, without AI/exec reservations.

## Residual risks

Valid-token abuse still reaches SQLite and is bounded only by application admissions; Workers ingress/CPU remains billable even for invalid traffic. Use edge controls/endpoint disable for abuse. This is bearer authentication, not SSO or a guaranteed account-wide spend cap. Existing unsigned demo credentials must be replaced; privately stored demo/bridge files will be updated without printing tokens.
