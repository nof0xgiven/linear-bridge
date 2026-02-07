import { z } from 'zod'

export const TriggerTypeSchema = z.enum(['label', 'hashtag', 'mention'])
export const TriggerActionSchema = z.enum(['full', 'quick', 'context', 'guide', 'plan', 'reply', 'review', 'github'])
export const TriggerEventSchema = z.enum(['create', 'update', 'remove'])

export const SandboxAgentSchema = z.enum(['claude', 'codex', 'opencode', 'amp'])

export const TriggerSchema = z.object({
  type: TriggerTypeSchema,
  value: z.string().min(1),
  action: TriggerActionSchema,
  agent: SandboxAgentSchema.optional(),
  on: z.array(TriggerEventSchema).optional(),
})

export const WorkspaceSchema = z.object({
  name: z.string().min(1),
  teamId: z.string().min(1),
  projectIds: z.array(z.string().min(1)).optional().default([]),
  localPath: z.string().min(1),
  automation: z.object({
    coding: z.object({
      // Workflow state name or ID (UUID). Resolved at runtime per team.
      setInProgressState: z.string().min(1).optional(),
      setInReviewStateOnSuccess: z.string().min(1).optional(),
      removeTriggerLabelOnSuccess: z.boolean().default(true),
    }).optional(),
  }).optional(),
  guide: z.object({
    enabled: z.boolean().default(true),
    docsPath: z.string().min(1).optional(),
    docsBaseUrl: z.string().min(1).optional(),
    serverUrl: z.string().min(1).default('http://localhost:3000'),
    usernameEnv: z.string().min(1).default('GUIDE_USERNAME'),
    passwordEnv: z.string().min(1).default('GUIDE_PASSWORD'),
    templatePath: z.string().min(1).default('templates/user_guide.md'),
    screenshotsDir: z.string().min(1).default('assets/guides/{ISSUE_ID}'),
  }).optional(),
})

export const ServerSchema = z.object({
  port: z.number().int().positive().default(4747),
  host: z.string().min(1).default('0.0.0.0'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  rateLimit: z.object({
    enabled: z.boolean().default(true),
    windowMs: z.number().int().positive().default(60000),
    max: z.number().int().positive().default(60),
  }).default({}),
})

export const LinearOAuthSchema = z.object({
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  redirectUri: z.string().url().optional(),
}).default({})

export const LinearSchema = z.object({
  apiKey: z.string().min(1),
  webhookSecret: z.string().min(1),
  oauth: LinearOAuthSchema,
  workspaces: z.array(WorkspaceSchema).min(1),
  triggers: z.array(TriggerSchema).default([]),
})

export const SandboxDefaultSchema = z.object({
  agent: SandboxAgentSchema,
  agentMode: z.string().min(1).optional(),
  permissionMode: z.enum(['default', 'plan', 'bypass']).default('default'),
  timeoutMs: z.number().int().positive().default(1800000),
  progressIntervalMs: z.number().int().positive().default(60000),
  reasoning: z.string().min(1).optional(),
  promptPrefix: z.string().min(1).optional(),
  promptSuffix: z.string().min(1).optional(),
})

export const SandboxOverrideSchema = SandboxDefaultSchema.partial().extend({
  workspace: z.string().min(1),
})

export const SandboxSchema = z.object({
  default: SandboxDefaultSchema,
  overrides: z.array(SandboxOverrideSchema).default([]),
  connection: z.object({
    baseUrl: z.string().url().optional(),
    token: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
  }).default({}),
})

export const ContextSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().min(1).default('rp-cli -e \'context_builder task="{TASK}"\''),
  timeoutMs: z.number().int().positive().default(600000),
  maxOutputSize: z.number().int().positive().default(50000),
})

export const WorktreeSchema = z.object({
  nameTemplate: z.string().min(1).default('{WORKSPACE_PATH}-worktrees/{ISSUE_ID}'),
  branchTemplate: z.string().min(1).default('fix/{ISSUE_ID}'),
  postCreateScript: z.string().min(1).optional(),
  cleanupOnComplete: z.boolean().default(false),
})

export const ProgressSchema = z.object({
  updateIntervalMs: z.number().int().positive().default(60000),
  includeToolCalls: z.boolean().default(true),
  includeFileChanges: z.boolean().default(true),
})

export const BotSchema = z.object({
  mentionName: z.string().min(1).default('et'),
})

export const MentionReplySchema = z.object({
  templatePath: z.string().min(1).default('templates/mention_reply.md'),
  stripMention: z.boolean().default(true),
  maxAnswerChars: z.number().int().positive().default(50000),
  maxContextComments: z.number().int().positive().default(10),
}).default({})

export const ReviewSchema = z.object({
  templatePath: z.string().min(1).default('templates/review.md'),
  maxDiffChars: z.number().int().positive().default(120000),
  maxContextComments: z.number().int().positive().default(10),
  maxCommentChars: z.number().int().positive().default(50000),
}).default({})

export const GitHubRepoSchema = z.object({
  workspace: z.string().min(1),
  repo: z.string().min(1),
  remote: z.string().min(1).default('origin'),
  baseBranch: z.string().min(1).optional(),
  pr: z.object({
    draft: z.boolean().default(true),
    titleTemplate: z.string().min(1).default('{ISSUE_ID}: {ISSUE_TITLE}'),
    bodyTemplatePath: z.string().min(1).optional(),
  }).default({}),
}).strict()

export const GitHubSchema = z.object({
  enabled: z.boolean().default(false),
  webhookSecret: z.string().min(1).optional(),
  autoCommit: z.boolean().default(false),
  commitMessageTemplate: z.string().min(1).default('{ISSUE_ID}: {ISSUE_TITLE}'),
  repos: z.array(GitHubRepoSchema).default([]),
  cleanup: z.object({
    enabled: z.boolean().default(false),
    removeWorktreeOnMerge: z.boolean().default(true),
    deleteBranchOnMerge: z.boolean().default(true),
  }).default({}),
}).default({})

export const AdvancedSchema = z.object({
  enableTelemetry: z.boolean().default(true),
  enableMetrics: z.boolean().default(true),
  enableHealthCheck: z.boolean().default(true),
  enableInspector: z.boolean().default(false),
  deadLetterPath: z.string().min(1).default('logs/dead-letter.jsonl'),
})

export const AppConfigSchema = z.object({
  version: z.string().min(1).default('1.0'),
  server: ServerSchema,
  linear: LinearSchema,
  sandbox: SandboxSchema,
  context: ContextSchema,
  worktree: WorktreeSchema,
  progress: ProgressSchema,
  bot: BotSchema,
  mentionReply: MentionReplySchema,
  review: ReviewSchema,
  github: GitHubSchema,
  advanced: AdvancedSchema,
})

export type AppConfig = z.infer<typeof AppConfigSchema>
export type TriggerConfig = z.infer<typeof TriggerSchema>
export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>
export type SandboxConfig = z.infer<typeof SandboxDefaultSchema>
export type SandboxOverrideConfig = z.infer<typeof SandboxOverrideSchema>
