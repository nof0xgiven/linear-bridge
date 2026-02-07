import { z } from 'zod'

/**
 * Linear webhook payload schemas
 * @see https://developers.linear.app/docs/graphql/webhooks
 */

export const LinearUserSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const LinearLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const LinearIssueDataSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  identifier: z.string().optional(),
  url: z.string().optional(),
  labels: z.array(LinearLabelSchema).optional(),
  labelIds: z.array(z.string()).optional(),
})

export const LinearCommentDataSchema = z.object({
  id: z.string(),
  body: z.string(),
  issueId: z.string(),
  userId: z.string().optional(),
  user: LinearUserSchema.optional(),
})

export const LinearWebhookUpdatedFromSchema = z.object({
  labelIds: z.array(z.string()).optional(),
}).passthrough()

export const LinearWebhookPayloadSchema = z.object({
  action: z.enum(['create', 'update', 'remove']),
  type: z.enum(['Comment', 'Issue']),
  data: z.union([LinearCommentDataSchema, LinearIssueDataSchema]),
  updatedFrom: LinearWebhookUpdatedFromSchema.optional(),
  url: z.string().optional(),
  createdAt: z.string(),
  webhookTimestamp: z.number().int().optional(),
  webhookId: z.string().min(1).optional(),
  organizationId: z.string().optional(),
})

export type LinearUser = z.infer<typeof LinearUserSchema>
export type LinearIssueData = z.infer<typeof LinearIssueDataSchema>
export type LinearCommentData = z.infer<typeof LinearCommentDataSchema>
export type LinearWebhookPayload = z.infer<typeof LinearWebhookPayloadSchema>

export interface ContextBuilderResult {
  success: boolean
  output: string
  error?: string
}

// Sandbox execution result
export interface SandboxResult {
  success: boolean
  sessionId: string
  reason: 'completed' | 'error' | 'terminated' | 'timeout'
  filesModified: string[]
  summary: string
  answer?: string
  error?: string
}

// Worktree result
export interface WorktreeResult {
  success: boolean
  path: string
  branch: string
  error?: string
}
