import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

// Subprocess tests provide a synthetic administrator policy without touching /etc
// or adding a runtime override for the protected path.
const directories = process.platform === 'darwin' ? ['/', '/private', '/private/etc'] : ['/', '/etc'];
const policy = `${directories.at(-1)}/openclaw-scheduler-model-catalog.json`;
const fixturePolicy = join(process.env.HOME, 'model-catalog-policy-fixture.json');
const lstat = fs.lstatSync;
const open = fs.openSync;
const fstat = fs.fstatSync;
const close = fs.closeSync;
let policyDescriptor;

if (process.geteuid?.() === 0) process.geteuid = () => 501;
fs.lstatSync = (path, ...args) => directories.includes(path)
  ? { uid: 0, mode: 0o755, isDirectory: () => true }
  : lstat(path, ...args);
fs.openSync = (path, ...args) => {
  if (path !== policy) return open(path, ...args);
  policyDescriptor = open(fixturePolicy, ...args);
  return policyDescriptor;
};
fs.fstatSync = (descriptor, ...args) => {
  const stat = fstat(descriptor, ...args);
  if (descriptor === policyDescriptor) stat.uid = 0;
  return stat;
};
fs.closeSync = descriptor => {
  if (descriptor === policyDescriptor) policyDescriptor = undefined;
  return close(descriptor);
};
syncBuiltinESMExports();
