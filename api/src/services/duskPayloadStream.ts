import type { Request, Response } from 'express';
import { currentPayload, payloadSelection } from './duskPayloads';
import {
  createDuskSnapshotHub,
  openDuskSnapshotStream,
} from './duskSnapshotStream';

const hub = createDuskSnapshotHub(currentPayload, (selection) =>
  JSON.stringify(selection),
);
export function openDuskPayloadStream(req: Request, res: Response) {
  return openDuskSnapshotStream(
    req,
    res,
    payloadSelection(req.query),
    'dusk-payload',
    hub,
  );
}
