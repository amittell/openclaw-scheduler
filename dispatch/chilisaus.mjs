#!/usr/bin/env node
/**
 * chilisaus 🌶️ — branded dispatch wrapper
 *
 * Sets DISPATCH_CONFIG_DIR so dispatch/index.mjs picks up chilisaus branding
 * from config.json in this directory. All args pass through to the dispatch engine.
 *
 * This is the canonical chilisaus entry point — not a symlink, not a fork.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Point config resolution to this directory (chilisaus/config.json)
const __dir = dirname(fileURLToPath(import.meta.url));
process.env.DISPATCH_CONFIG_DIR = __dir;

// Import and run the dispatch engine
const dispatchPath = join(__dir, 'index.mjs');
await import(dispatchPath);
