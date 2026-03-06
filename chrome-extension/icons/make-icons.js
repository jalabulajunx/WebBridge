#!/usr/bin/env node
/**
 * Generates PNG icons for the WebBridge Chrome extension.
 * Uses the `canvas` npm package.
 *
 * Usage (run once):
 *   npm install canvas
 *   node make-icons.js
 *
 * Or install icons manually from any 16x16, 48x48, and 128x128 PNG sources
 * named icon16.png, icon48.png, icon128.png in this directory.
 */

'use strict';

const fs = require('fs');
const path = require('path');

try {
  const { createCanvas } = require('canvas');
  [16, 48, 128].forEach((size) => {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Background: dark indigo rounded rect
    const r = size * 0.2;
    ctx.fillStyle = '#312e81';
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(size - r, 0);
    ctx.quadraticCurveTo(size, 0, size, r);
    ctx.lineTo(size, size - r);
    ctx.quadraticCurveTo(size, size, size - r, size);
    ctx.lineTo(r, size);
    ctx.quadraticCurveTo(0, size, 0, size - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();

    // Hexagon in indigo/purple
    ctx.fillStyle = '#6366f1';
    const cx = size / 2;
    const cy = size / 2;
    const hr = size * 0.35;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const x = cx + hr * Math.cos(angle);
      const y = cy + hr * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    // White "W" letter
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${size * 0.38}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('W', cx, cy + size * 0.03);

    const buffer = canvas.toBuffer('image/png');
    const outPath = path.join(__dirname, `icon${size}.png`);
    fs.writeFileSync(outPath, buffer);
    console.log(`Written: icon${size}.png`);
  });
  console.log('Icons generated successfully.');
} catch (e) {
  console.error(
    'Could not generate icons (canvas not installed).\n' +
    'Run: npm install canvas && node make-icons.js\n' +
    'Or place icon16.png, icon48.png, icon128.png manually.\n',
    e.message
  );
  process.exit(1);
}
