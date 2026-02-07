# Mention Reply Request

A comment has been posted on a Linear ticket tagging you.

## Context

- Mention: {mention}
- Linear Issue: {issue_identifier}
- Title: {issue_title}
- Issue URL: {issue_url}

## Task (Y)

{issue_title}

{issue_description}

## User Comment (Z)

{user_comment}

## Parsed Question

{question}

## Resources (X)

You have access to:

- The local repository at: {repo_path}
- A non-interactive shell (you can run commands like `rg`, `ls`, `cat`, `sed -n`)

## Recent Comments

{recent_comments}

## Instructions

- Answer the user's question clearly and directly.
- If you need clarification, include up to 3 specific follow-up questions in your reply.
- Do not modify any files. Do not write/patch files, do not commit, and do not run destructive commands.
- If you inspect code, use read-only commands.
- Do not post back to Linear directly. Do not use `mcp-cli` or any Linear/MCP tools to create or update comments. Your response must be in the assistant message only.
- Keep the response suitable for a Linear comment (Markdown is fine).
