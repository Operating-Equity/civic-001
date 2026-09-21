// The one registry the server runs on, built from the environment at startup.
import { loadAdapters, buildRegistry } from './registry.js';

export const registry = buildRegistry(await loadAdapters());
