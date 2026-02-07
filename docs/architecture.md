# Architecture

## Core Flow

```
Webhook → Trigger Match → (Context Builder?) → Worktree → (Post-Create Script?) → Sandbox Agent → Linear Updates
```

## Components

- `src/index.ts`: HTTP entrypoint.
- `src/webhook.ts`: Orchestration and trigger routing.
- `src/config/*`: Config loading and validation.
- `src/workspace.ts`: Workspace resolution.
- `src/triggers/*`: Trigger evaluation.
- `src/sandbox.ts`: Agent runtime.
- `src/worktree.ts`: Git worktree management.

## Design Principles

- Configuration-driven behavior.
- Minimal workflow changes.
- Clear failure modes and observability.
