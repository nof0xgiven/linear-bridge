import fs from 'fs'
import path from 'path'
import type { AppConfig } from './schema'

export function validateConfig(config: AppConfig): void {
  const errors: string[] = []

  validateWorkspaces(config, errors)
  validateTriggers(config, errors)
  validateSandboxOverrides(config, errors)
  validateOAuth(config, errors)
  validateContext(config, errors)
  validateGuideConfig(config, errors)
  validateMentionReplyConfig(config, errors)
  validateReviewConfig(config, errors)
  validateGitHubConfig(config, errors)

  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n- ${errors.join('\n- ')}`)
  }
}

function validateWorkspaces(config: AppConfig, errors: string[]): void {
  const names = new Set<string>()
  const workspaceNames = config.linear.workspaces.map((workspace) => workspace.name)
  for (const name of workspaceNames) {
    if (names.has(name)) {
      errors.push(`Duplicate workspace name: ${name}`)
    }
    names.add(name)
  }

  for (const workspace of config.linear.workspaces) {
    if (!fs.existsSync(workspace.localPath)) {
      errors.push(`Workspace path does not exist: ${workspace.localPath}`)
      continue
    }
    const stats = fs.statSync(workspace.localPath)
    if (!stats.isDirectory()) {
      errors.push(`Workspace path is not a directory: ${workspace.localPath}`)
      continue
    }
    const gitPath = path.join(workspace.localPath, '.git')
    if (!fs.existsSync(gitPath)) {
      errors.push(`Workspace is not a git repo: ${workspace.localPath}`)
    }
  }
}

function validateSandboxOverrides(config: AppConfig, errors: string[]): void {
  const workspaceNames = new Set(config.linear.workspaces.map((workspace) => workspace.name))
  for (const override of config.sandbox.overrides) {
    if (!workspaceNames.has(override.workspace)) {
      errors.push(`Sandbox override references unknown workspace: ${override.workspace}`)
    }
  }
}

function validateOAuth(config: AppConfig, errors: string[]): void {
  const oauth = config.linear.oauth
  const hasAny = Boolean(oauth.clientId || oauth.clientSecret || oauth.redirectUri)
  const hasAll = Boolean(oauth.clientId && oauth.clientSecret && oauth.redirectUri)
  if (hasAny && !hasAll) {
    errors.push('linear.oauth requires clientId, clientSecret, and redirectUri when configured')
  }
}

function validateContext(config: AppConfig, errors: string[]): void {
  if (config.context.enabled && !config.context.command.includes('{TASK}')) {
    errors.push('context.command must include {TASK} placeholder when context is enabled')
  }
}

function validateTriggers(config: AppConfig, errors: string[]): void {
  for (const trigger of config.linear.triggers) {
    if (trigger.type === 'mention') {
      if (trigger.action !== 'reply') {
        errors.push(`Mention trigger must use action "reply" (value: ${trigger.value})`)
      }
      if (!trigger.agent) {
        errors.push(`Mention trigger requires "agent" (value: ${trigger.value})`)
      }
    }

    if (trigger.action === 'reply' && trigger.type !== 'mention') {
      errors.push(`Action "reply" is only supported for trigger type "mention" (value: ${trigger.value})`)
    }

    if (trigger.action === 'review' && trigger.type !== 'label') {
      errors.push(`Action "review" is only supported for trigger type "label" (value: ${trigger.value})`)
    }

    if (trigger.action === 'github' && trigger.type !== 'label') {
      errors.push(`Action "github" is only supported for trigger type "label" (value: ${trigger.value})`)
    }

    // Comment webhook handler only processes Comment create events.
    if ((trigger.type === 'mention' || trigger.type === 'hashtag') && trigger.on) {
      const invalid = trigger.on.filter((event) => event !== 'create')
      if (invalid.length > 0) {
        errors.push(
          `${trigger.type} trigger only supports on: [create] (value: ${trigger.value}; invalid: ${invalid.join(', ')})`
        )
      }
    }
  }
}

function validateGuideConfig(config: AppConfig, errors: string[]): void {
  for (const workspace of config.linear.workspaces) {
    const guide = workspace.guide
    if (!guide || !guide.enabled) {
      continue
    }

    if (!guide.docsPath) {
      errors.push(`Guide docsPath is required for workspace: ${workspace.name}`)
      continue
    }
    if (!fs.existsSync(guide.docsPath)) {
      errors.push(`Guide docsPath does not exist: ${guide.docsPath}`)
      continue
    }
    const docsStats = fs.statSync(guide.docsPath)
    if (!docsStats.isDirectory()) {
      errors.push(`Guide docsPath is not a directory: ${guide.docsPath}`)
    }

    const templatePath = path.isAbsolute(guide.templatePath)
      ? guide.templatePath
      : path.join(process.cwd(), guide.templatePath)
    if (!fs.existsSync(templatePath)) {
      errors.push(`Guide templatePath does not exist: ${templatePath}`)
    }
  }
}

function validateMentionReplyConfig(config: AppConfig, errors: string[]): void {
  const templatePath = path.isAbsolute(config.mentionReply.templatePath)
    ? config.mentionReply.templatePath
    : path.join(process.cwd(), config.mentionReply.templatePath)
  if (!fs.existsSync(templatePath)) {
    errors.push(`mentionReply.templatePath does not exist: ${templatePath}`)
  }
}

function validateReviewConfig(config: AppConfig, errors: string[]): void {
  const templatePath = path.isAbsolute(config.review.templatePath)
    ? config.review.templatePath
    : path.join(process.cwd(), config.review.templatePath)
  if (!fs.existsSync(templatePath)) {
    errors.push(`review.templatePath does not exist: ${templatePath}`)
  }
}

function validateGitHubConfig(config: AppConfig, errors: string[]): void {
  if (!config.github.enabled) {
    return
  }

  if (config.github.repos.length === 0) {
    errors.push('github.repos must be configured when github.enabled=true')
    return
  }

  const workspaceNames = new Set(config.linear.workspaces.map((workspace) => workspace.name))
  for (const repo of config.github.repos) {
    if (!workspaceNames.has(repo.workspace)) {
      errors.push(`github.repos references unknown workspace: ${repo.workspace}`)
    }

    if (repo.pr.bodyTemplatePath) {
      const templatePath = path.isAbsolute(repo.pr.bodyTemplatePath)
        ? repo.pr.bodyTemplatePath
        : path.join(process.cwd(), repo.pr.bodyTemplatePath)
      if (!fs.existsSync(templatePath)) {
        errors.push(`github.repos[].pr.bodyTemplatePath does not exist: ${templatePath}`)
      }
    }
  }

  if (config.github.cleanup.enabled && !config.github.webhookSecret) {
    errors.push('github.webhookSecret is required when github.cleanup.enabled=true')
  }
}
