# GO / NO-GO Checklist (single-host LAN rollout)

Use this checklist immediately after pilot execution.

## GO criteria (all required)

- [ ] Host preflight passes (`lan:host:preflight`)
- [ ] API health endpoint is green from host and all clients
- [ ] All clients point to same internal API URL
- [ ] LAN session login works for required roles
- [ ] Roster/sortie create/update/delete sync across PCs
- [ ] Schedule chain transitions work end-to-end
- [ ] Messages and pending approvals sync correctly
- [ ] Audit page reflects operational events
- [ ] Host restart recovery succeeds (temporary outage, then recovery)
- [ ] Backup completed successfully
- [ ] Restore drill completed and data verified
- [ ] No critical/high blockers open

If any item is false -> `NO-GO`.

## NO-GO triggers (automatic stop)

- Any data loss during normal operations
- Schedule chain state corruption or missing transitions
- Cross-PC writes succeed on one node but do not replicate
- Authentication/session instability across pilot PCs
- Backup or restore failure
- Unresolved critical defect in ops/commander paths

## Expansion gate (to next squadron)

Expansion is allowed only when:

- pilot verdict is `GO`
- runbook deviations are documented and fixed
- final API/env templates are confirmed by IT
- rollback path is rehearsed

## Rollback decision

If `NO-GO`, rollback to last stable operation mode and do not expand.

Minimum rollback package:

- latest known-good backup
- issue log with reproduction
- owner + ETA per blocker
