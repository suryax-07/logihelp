import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest } from "../server/api-handler";

export default function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  return handleApiRequest(req, res);
}
