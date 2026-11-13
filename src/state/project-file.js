/**
 * Project file export/import — a self-describing JSON envelope around the
 * storage document.
 *
 * The payload is the same `{ schemaVersion, project }` document that lives in
 * `localStorage['magicbeatz-v1']`, so an exported file can be restored
 * verbatim. `kind` + `app` make it recognisable in a folder of random JSON,
 * and import stays tolerant: it also accepts a bare serialized project
 * (v2–v5, `patterns[]`), a legacy v1 pattern document (`channels[]`) or a raw
 * storage envelope. All schema migration/clamping is delegated to
 * `parseProject()`, so every historical version imports through the same path.
 *
 * `parseProjectFile()` always finishes validating before the caller swaps
 * state — an invalid file can never clobber the project that is open.
 */
import {
  arrangementBars,
  parseProject,
  serializeProject,
} from '../sequencer/project.js';

export const PROJECT_FILE_KIND = 'magicbeatz-project';
export const PROJECT_FILE_SCHEMA = 1;

/** Thrown for unreadable / unrelated files; `message` is user-facing. */
export class ProjectFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

/** Local-time `YYYYMMDD-HHmm` stamp — filenames should match the user's clock. */
function fileStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Filesystem-safe slug; unicode is stripped to ASCII, never to an empty name. */
function fileSlug(value, fallback = 'project') {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** Envelope written to disk (pretty printing lives in stringifyProjectFile). */
export function buildProjectFile(project, date = new Date()) {
  return {
    kind: PROJECT_FILE_KIND,
    app: 'magicbeatz',
    schemaVersion: PROJECT_FILE_SCHEMA,
    savedAt: (date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()).toISOString(),
    project: serializeProject(project),
  };
}

/** Export text: stable key order, 2-space indent, trailing newline. */
export function stringifyProjectFile(project, date = new Date()) {
  return `${JSON.stringify(buildProjectFile(project, date), null, 2)}\n`;
}

/**
 * Download name for a project: `magicbeatz-<grid-slug>-YYYYMMDD-HHmm.json`.
 * The active Grid names the file; an unnamed project falls back to `project`.
 */
export function projectFileName(project, date = new Date()) {
  const patterns = Array.isArray(project?.patterns) ? project.patterns : [];
  const active = patterns.find((p) => p.id === project?.activePatternId) || patterns[0];
  return `magicbeatz-${fileSlug(active?.name)}-${fileStamp(date)}.json`;
}

/** A project document must carry at least one Grid (or a legacy v1 channel). */
function hasGrids(doc) {
  return (Array.isArray(doc?.patterns) && doc.patterns.length > 0)
    || (Array.isArray(doc?.channels) && doc.channels.length > 0);
}

/** Unwrap a stored/exported document down to a `parseProject()` input. */
function projectDocument(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ProjectFileError('not a magicbeatz project');
  }
  if (Object.prototype.hasOwnProperty.call(data, 'project')) {
    if (!data.project || typeof data.project !== 'object' || Array.isArray(data.project)) {
      throw new ProjectFileError('not a magicbeatz project (bad project payload)');
    }
    if (!hasGrids(data.project)) {
      throw new ProjectFileError('not a magicbeatz project (no grids found)');
    }
    return data.project;
  }
  if (!hasGrids(data)) {
    throw new ProjectFileError('not a magicbeatz project (no grids found)');
  }
  return data;
}

/**
 * Parse export text into a fresh project document.
 *
 * Accepts the export envelope, the storage envelope, a bare serialized
 * project, or a legacy v1 pattern. Throws `ProjectFileError` with a
 * human-readable message for anything else.
 */
export function parseProjectFile(text) {
  if (typeof text !== 'string') {
    throw new ProjectFileError('not valid JSON');
  }
  if (!text.trim()) {
    throw new ProjectFileError('not valid JSON (empty file)');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProjectFileError('not valid JSON');
  }
  return parseProject(projectDocument(data));
}

/** Short counts for the import/export notice. */
export function summarizeProject(project) {
  return {
    grids: Array.isArray(project?.patterns) ? project.patterns.length : 0,
    bars: arrangementBars(project),
  };
}
