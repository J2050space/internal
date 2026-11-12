// WebMCP bootstrap: exposes the page's read-only tools to browser agents.
// WebMCP is a draft standard (document.modelContext), so everything here is a
// progressive enhancement: when the API is missing no tool code is loaded and
// nothing runs.
import { supabase } from '../config.js';

let controller = null;

export function getModelContext() {
  return document.modelContext ?? navigator.modelContext ?? null;
}

export function isWebMcpAvailable() {
  return Boolean(getModelContext());
}

// Registers the tools of a protected page. Safe to call once per page after
// initProtectedPage(); a new call replaces the previous registration.
export async function mountWebMcp(profile, page) {
  const ctx = getModelContext();
  if (!ctx || !profile) return null;
  controller?.abort();
  const current = new AbortController();
  controller = current;
  try {
    const [{ registerTools }, { createData }] = await Promise.all([
      import('./tools.js'),
      import('./data.js'),
    ]);
    const data = createData(supabase, { profile });
    await registerTools(ctx, { profile, page, data }, { signal: current.signal });
  } catch (error) {
    console.warn('WebMCP tools not registered:', error);
    return null;
  }
  return current;
}

// Aborting the registration signal unregisters the tools (WebMCP spec).
export function unmountWebMcp() {
  controller?.abort();
  controller = null;
}
