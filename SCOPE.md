# User Guide Agent

An automated AI Agent for creating user walkthrough guides.

## Workflow

- User adds label to ticket in Linear as "guide"
- Bot responds with "User guide in progress.."
- Sandbox created
- AI agent;
  - Checks task description against codebase
  - Determines what should be shown for engaging user guide
  - Login to Local Website
  ┌───────────────────────────────┬─────────────────────────────┐
  │             Tool              │          Sequence           │
  ├───────────────────────────────┼─────────────────────────────┤
  │ chrome-devtools/new_page      │ Open a new browser tab      │
  ├───────────────────────────────┼─────────────────────────────┤
  │ chrome-devtools/navigate_page │ Go to localhost login URL   │
  ├───────────────────────────────┼─────────────────────────────┤
  │ chrome-devtools/fill          │ Enter username              │
  ├───────────────────────────────┼─────────────────────────────┤
  │ chrome-devtools/fill          │ Enter password              │
  ├───────────────────────────────┼─────────────────────────────┤
  │ chrome-devtools/click         │ Click login button          │
  ├───────────────────────────────┼─────────────────────────────┤
  │ chrome-devtools/wait_for      │ Wait for dashboard/redirect │
  └───────────────────────────────┴─────────────────────────────┘
  - Navigate Feature & Capture Screenshots
  ┌─────────────────────────────────┬───────────────────────────┐
  │              Tool               │          Purpose          │
  ├─────────────────────────────────┼───────────────────────────┤
  │ chrome-devtools/navigate_page   │ Go to feature page        │
  ├─────────────────────────────────┼───────────────────────────┤
  │ chrome-devtools/wait_for        │ Wait for page to load     │
  ├─────────────────────────────────┼───────────────────────────┤
  │ chrome-devtools/take_screenshot │ Capture each step         │
  ├─────────────────────────────────┼───────────────────────────┤
  │ chrome-devtools/click           │ Interact with UI elements │
  ├─────────────────────────────────┼───────────────────────────┤
  │ chrome-devtools/fill            │ Demo form inputs          │
  ├─────────────────────────────────┼───────────────────────────┤
  │ repeat as needed                │                           │
  └─────────────────────────────────┴───────────────────────────┘
  - Write User Guide
  ┌───────┬─────────────────────────────────────────┐
  │ Tool  │                 Purpose                 │
  ├───────┼─────────────────────────────────────────┤
  │ Write │ Create markdown file with guide content │
  ├───────┼─────────────────────────────────────────┤
  │       │ Embed screenshot references             │
  ├───────┼─────────────────────────────────────────┤
  │       │ Document each step with descriptions    │
  └───────┴─────────────────────────────────────────┘
  - post comment with link on Linear

## Example Template

---
title: [Task Name]
description: [One-line what user will accomplish]
icon: [Relevant Lucide icon]
---

## Overview
[1-2 sentences: what this feature does and why they'd use it]

## Steps
[Numbered walkthrough with screenshots/GIFs at key moments]

## Common Issues (optional)
[Troubleshooting if relevant]

## Guides Saved in Fumadocs
Guides are written to the configured `linear.workspaces[].guide.docsPath`.

## Requirements
1. localhost:3000 must be running
2. username/password must be provided
3. AI agent must have chrome dev tools

## POC

Example
- Docs path: `/path/to/docs`
- Main repo path: `/path/to/repo`
- Agent: `claude`
- Prompt: `templates/user_guide.md`
- Worktree: no
- Server: localhost:3000
- Username: user@example.com
- Password: (from env)
