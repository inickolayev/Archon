import { z } from '@hono/zod-openapi';
import {
  nodeSkipReasonSchema as engineNodeSkipReasonSchema,
  skipCauseSchema as engineSkipCauseSchema,
} from '@archon/workflows/schemas/workflow-run';
import { effortLevelSchema } from '@archon/workflows/schemas/effort';
import { tierNameSchema } from '@archon/workflows/schemas/model-binding';

export const skipCauseSchema = engineSkipCauseSchema.openapi('SkipCause');
export const nodeSkipReasonSchema = engineNodeSkipReasonSchema.openapi('NodeSkipReason');

export const dagNodeSseEventSchema = z
  .object({
    type: z.literal('dag_node'),
    runId: z.string(),
    nodeId: z.string(),
    name: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'skipped']),
    duration: z.number().optional(),
    error: z.string().optional(),
    reason: nodeSkipReasonSchema.optional(),
    cause: skipCauseSchema.optional(),
    // Set on `running` only, from the engine's node_started event; absent for
    // bash/script nodes, which run no model.
    provider: z.string().optional(),
    model: z.string().optional(),
    tier: tierNameSchema.optional(),
    effort: effortLevelSchema.optional(),
    /** The dispatched run's workflow, when the event is bridged into the chat that started it. */
    workflowName: z.string().optional(),
    timestamp: z.number(),
  })
  .openapi('DagNodeSseEvent');

export type DagNodeSseEvent = z.infer<typeof dagNodeSseEventSchema>;
