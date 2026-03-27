import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load server/.env before any other app code reads process.env.
// Works when cwd is repo root (npm workspaces) or server/.
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(here, "..");
dotenv.config({ path: path.join(serverRoot, ".env") });
// Fallback: also try cwd/.env (e.g. running from server/ with only .env there)
dotenv.config();
