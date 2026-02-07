#!/usr/bin/env bun
import { deleteComment } from '../src/linear'

const botCommentIds = [
  '2395f45e-a283-4671-b27e-ffed689b2834', // Sandbox Bot Error (timeout)
  '1d7e33e5-6bb4-49cd-828a-66eabb45c8b2', // Sandbox Bot Error (timeout)
  '9fd5f32d-1bd8-49f0-9da5-c9f44c715647', // Sandbox Bot - Worktree Failed
  '39a2cdda-b068-4178-a017-2e760df06bdd', // Sandbox Bot Error (connection)
  'aa312941-a60f-4c98-9fee-a380f8b74dc6', // Context Builder Result
]

console.log('Deleting bot comments...')

for (const commentId of botCommentIds) {
  try {
    await deleteComment(commentId)
    console.log(`✅ Deleted comment ${commentId}`)
  } catch (error) {
    console.error(`❌ Failed to delete comment ${commentId}:`, error)
  }
}

console.log('Done!')
