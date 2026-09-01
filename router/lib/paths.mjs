// ~/claude-skills/router/lib/paths.mjs
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nonEmpty = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

export const routerDir = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const home = () => nonEmpty(process.env.HOME) || os.homedir();
export const stateDir = () => nonEmpty(process.env.ROUTER_STATE_DIR) || path.join(home(), '.claude', 'router-state');
export const runsDir = () => nonEmpty(process.env.SKILL_RUNS_DIR) || path.join(home(), '.claude', 'skill-runs');
export const rulesPath = () => nonEmpty(process.env.ROUTER_RULES) || path.join(routerDir(), 'skill-rules.json');
export const skillsDir = () => path.join(routerDir(), '..', 'skills');
