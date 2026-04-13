import path from "node:path";

function isWindowsDriveRoot(value) {
  return /^[A-Za-z]:\\$/.test(value);
}

export function stripExtendedPathPrefix(value) {
  if (!value) {
    return "";
  }

  if (value.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
  }

  if (value.startsWith("\\\\?\\")) {
    return value.slice("\\\\?\\".length);
  }

  return value;
}

export function normalizeWindowsPath(value) {
  const stripped = stripExtendedPathPrefix(String(value ?? "").trim()).replaceAll("/", "\\");
  if (!stripped) {
    return "";
  }

  let normalized = path.win32.normalize(stripped);
  if (normalized.endsWith("\\") && !isWindowsDriveRoot(normalized)) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

export function normalizeWindowsPathKey(value) {
  return normalizeWindowsPath(value).toLowerCase();
}

export function projectNameFromPath(projectPath) {
  const normalized = normalizeWindowsPath(projectPath);
  return path.win32.basename(normalized) || normalized;
}

export function unixSecondsToIso(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return new Date(value * 1_000).toISOString();
}

export function getTrustedProjects(config) {
  const projects = config?.result?.config?.projects ?? config?.config?.projects ?? {};

  return Object.entries(projects)
    .filter(([, details]) => details?.trust_level === "trusted")
    .map(([projectPath, details]) => {
      const normalizedPath = normalizeWindowsPath(projectPath);
      return {
        projectId: normalizedPath,
        path: normalizedPath,
        pathKey: normalizeWindowsPathKey(normalizedPath),
        name: projectNameFromPath(normalizedPath),
        trusted: true,
        trustLevel: details?.trust_level ?? "unknown",
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function requireTrustedProject(projects, projectId) {
  const wanted = normalizeWindowsPathKey(projectId);
  const project = projects.find((item) => item.pathKey === wanted);
  if (!project) {
    throw new Error(`Unknown or untrusted project: ${projectId}`);
  }
  return project;
}

export function filterThreadsForProject(threads, project, query) {
  const targetKey = project.pathKey;
  const queryText = String(query ?? "").trim().toLowerCase();

  return threads
    .filter((thread) => normalizeWindowsPathKey(thread?.cwd) === targetKey)
    .filter((thread) => {
      if (!queryText) {
        return true;
      }

      const haystack = [
        thread?.id,
        thread?.name,
        thread?.preview,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(queryText);
    })
    .map((thread) => ({
      threadId: thread.id,
      name: thread.name || thread.preview || thread.id,
      status: thread?.status?.type || "unknown",
      lastActivityAt: unixSecondsToIso(thread.updatedAt),
      projectId: project.projectId,
      cwd: normalizeWindowsPath(thread.cwd),
    }))
    .sort((left, right) => String(right.lastActivityAt || "").localeCompare(String(left.lastActivityAt || "")));
}

export function findThreadById(threads, threadId) {
  return threads.find((thread) => thread.id === threadId) ?? null;
}
