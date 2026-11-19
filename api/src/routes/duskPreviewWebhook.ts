import type { Request, Response } from 'express';
import {
  PREVIEW_PROJECT_ID,
  PREVIEW_SCHEMA,
  PREVIEW_TEAM_ID,
  parsePreviewEvent,
  readPreviewOrigins,
  recordPreviewEvent,
  verifyVercelSignature,
} from '../services/duskPreviewOrigins';

export async function previewWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const secret = process.env.DUSK_VERCEL_WEBHOOK_SECRET;
  if (!secret) {
    res
      .status(503)
      .json({ success: false, error: 'Preview registration is unavailable' });
    return;
  }
  if (
    !Buffer.isBuffer(req.body) ||
    !verifyVercelSignature(req.body, req.headers['x-vercel-signature'], secret)
  ) {
    res
      .status(401)
      .json({ success: false, error: 'Invalid webhook signature' });
    return;
  }
  let event;
  try {
    event = parsePreviewEvent(req.body);
  } catch {
    res
      .status(400)
      .json({ success: false, error: 'Invalid preview deployment event' });
    return;
  }
  if (!event) {
    res.status(202).json({ success: true, ignored: true });
    return;
  }
  try {
    await recordPreviewEvent(event);
    res.status(200).json({ success: true });
  } catch {
    res
      .status(503)
      .json({ success: false, error: 'Preview registration is unavailable' });
  }
}

export async function previewOriginRegistry(
  _req: Request,
  res: Response,
): Promise<void> {
  res.set('Cache-Control', 'no-store');
  try {
    const origins = process.env.DUSK_VERCEL_WEBHOOK_SECRET
      ? await readPreviewOrigins()
      : [];
    res.json({
      schemaVersion: PREVIEW_SCHEMA,
      projectId: PREVIEW_PROJECT_ID,
      teamId: PREVIEW_TEAM_ID,
      origins,
    });
  } catch {
    res.status(503).json({ error: 'Preview registry is unavailable' });
  }
}
