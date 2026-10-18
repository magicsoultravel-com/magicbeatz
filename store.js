/**
 * magicbeatz storage — isolated from guitarsuite (see DeepSeek #4).
 * New key `magicbeatz-v1` with schemaVersion; one-shot read-only import
 * from the legacy `guitarsuite-magicbeatz` key, never cross-writes.
 */
import { parsePatternChannels } from '../src/magicBeatz/pattern.js';
import {
  createDefaultProject,
  parseProject as parseFullProject,
  serializeProject,
} from '../src/magicBeatz/project.js';

export const MBZ_KEY = 'magicbeatz-v1';
export const MBZ_PADMAP_KEY = 'magicbeatz-padmap-v1';
const LEGACY_KEY = 'guitarsuite-magicbeatz';

export function loadMbzProject() {
  try {
    const raw = localStorage.getItem(MBZ_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schemaVersion === 1 && parsed.project) {
        return { project: parseFullProject(parsed.project), imported: false };
      }
    }
  } catch { /* ignore */ }
  // One-shot read-only import from legacy key
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const project = parseFullProject(JSON.parse(legacy));
      saveMbzProject(project);
      return { project, imported: true };
    }
  } catch { /* ignore */ }
  const project = createDefaultProject();
  saveMbzProject(project);
  return { project, imported: false };
}

export function saveMbzProject(project) {
  try {
    localStorage.setItem(MBZ_KEY, JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      project: serializeProject(project),
    }));
  } catch { /* ignore */ }
}

export function resetMbzProject() {
  const project = createDefaultProject();
  saveMbzProject(project);
  return project;
}

// Minimal pattern parse guard — re-export for console use
export { createDefaultProject, parsePatternChannels };
