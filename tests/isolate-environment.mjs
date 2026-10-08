// The first import of every test entry point (test.js and tests/*.test.mjs).
// ES modules evaluate in import order, so this runs before any scheduler module
// captures HOME, the Gateway URL or a token from the environment.
import { isolateTestProcess } from '../scripts/test-environment.mjs';

isolateTestProcess();
