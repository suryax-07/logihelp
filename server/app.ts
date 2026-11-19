import cors from "cors";
import express from "express";
import { handleApiRequest } from "./api-handler";

export const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use((req, res) => {
  void handleApiRequest(req, res).catch((error: unknown) => {
    console.error("LogiHelp API request failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "Unexpected API error." });
  });
});

export default app;
