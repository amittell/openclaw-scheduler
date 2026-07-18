import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  resolveDispatchStateDir,
  resolveLabelsPath,
} from '../dispatch/paths.mjs';

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('dispatch labels default to the canonical scheduler state directory', () => {
  const homeDir = makeTempDir('dispatch-label-home-');
  const legacyDir = makeTempDir('dispatch-label-legacy-');
  const legacyPath = join(legacyDir, 'labels.json');
  writeFileSync(legacyPath, '{"legacy":true}\n');

  try {
    const env = { HOME: homeDir };
    const stateDir = resolveDispatchStateDir({ env });
    const labelsPath = resolveLabelsPath({ env, legacyCandidates: [legacyPath] });

    assert.equal(stateDir, resolve(homeDir, '.openclaw', 'scheduler', 'dispatch'));
    assert.equal(labelsPath, join(stateDir, 'labels.json'));
    assert.equal(readFileSync(labelsPath, 'utf8'), '{"legacy":true}\n');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

test('relative labels paths resolve beneath DISPATCH_STATE_DIR', () => {
  const rootDir = makeTempDir('dispatch-label-relative-');
  const stateDir = join(rootDir, 'state');

  try {
    const labelsPath = resolveLabelsPath({
      env: {
        DISPATCH_STATE_DIR: stateDir,
        DISPATCH_LABELS_PATH: join('nested', 'labels.json'),
      },
    });

    assert.equal(labelsPath, join(stateDir, 'nested', 'labels.json'));
    assert.equal(existsSync(join(stateDir, 'nested')), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('absolute labels paths are accepted only inside DISPATCH_STATE_DIR', () => {
  const rootDir = makeTempDir('dispatch-label-absolute-');
  const stateDir = join(rootDir, 'state');
  const labelsPath = join(stateDir, 'custom', 'labels.json');

  try {
    assert.equal(resolveLabelsPath({
      env: {
        DISPATCH_STATE_DIR: stateDir,
        DISPATCH_LABELS_PATH: labelsPath,
      },
    }), labelsPath);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('labels path traversal fails before creating an escaped directory', () => {
  const rootDir = makeTempDir('dispatch-label-traversal-');
  const stateDir = join(rootDir, 'state');
  const escapedDir = join(rootDir, 'escaped');

  try {
    assert.throws(
      () => resolveLabelsPath({
        env: {
          DISPATCH_STATE_DIR: stateDir,
          DISPATCH_LABELS_PATH: join('..', 'escaped', 'labels.json'),
        },
      }),
      /DISPATCH_LABELS_PATH escapes DISPATCH_STATE_DIR/u,
    );
    assert.equal(existsSync(escapedDir), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('absolute labels paths outside the state directory fail closed', () => {
  const rootDir = makeTempDir('dispatch-label-outside-');
  const stateDir = join(rootDir, 'state');
  const outsidePath = join(rootDir, 'outside', 'labels.json');

  try {
    assert.throws(
      () => resolveLabelsPath({
        env: {
          DISPATCH_STATE_DIR: stateDir,
          DISPATCH_LABELS_PATH: outsidePath,
        },
      }),
      /DISPATCH_LABELS_PATH escapes DISPATCH_STATE_DIR/u,
    );
    assert.equal(existsSync(join(rootDir, 'outside')), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('the labels path must name a file beneath the state directory', () => {
  const rootDir = makeTempDir('dispatch-label-root-');
  const stateDir = join(rootDir, 'state');

  try {
    assert.throws(
      () => resolveLabelsPath({
        env: {
          DISPATCH_STATE_DIR: stateDir,
          DISPATCH_LABELS_PATH: stateDir,
        },
      }),
      /DISPATCH_LABELS_PATH escapes DISPATCH_STATE_DIR/u,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('labels paths cannot escape through a symbolic-link directory', {
  skip: process.platform === 'win32',
}, () => {
  const rootDir = makeTempDir('dispatch-label-symlink-');
  const stateDir = join(rootDir, 'state');
  const outsideDir = join(rootDir, 'outside');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  symlinkSync(outsideDir, join(stateDir, 'linked'), 'dir');

  try {
    assert.throws(
      () => resolveLabelsPath({
        env: {
          DISPATCH_STATE_DIR: stateDir,
          DISPATCH_LABELS_PATH: join('linked', 'labels.json'),
        },
      }),
      /DISPATCH_LABELS_PATH escapes its allowed root through a symbolic link/u,
    );
    assert.equal(existsSync(join(outsideDir, 'labels.json')), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
