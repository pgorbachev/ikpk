import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';

const minimumVipsVersion = [8, 18, 2];

test('Sharp loads a libvips version patched for GHSA-jmwm-wc68-mhwm', () => {
  const loadedVersion = sharp.versions.vips;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(loadedVersion ?? '');

  assert.ok(match, `Sharp did not report a valid loaded libvips version: ${loadedVersion}`);

  const actual = match.slice(1, 4).map(Number);
  const firstDifference = actual.findIndex((part, index) => part !== minimumVipsVersion[index]);
  const meetsMinimum =
    firstDifference === -1 || actual[firstDifference] > minimumVipsVersion[firstDifference];

  assert.ok(
    meetsMinimum,
    `Loaded libvips ${loadedVersion} is vulnerable; require >= ${minimumVipsVersion.join('.')}`
  );
});
