import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The real SessionManager in the integration tests must not touch the user's omp agent directory.
const agentDir = mkdtempSync(path.join(tmpdir(), "omp-context-editor-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
	rmSync(agentDir, { recursive: true, force: true });
});
