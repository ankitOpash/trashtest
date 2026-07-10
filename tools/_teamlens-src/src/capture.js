'use strict';
const { desktopCapturer, screen, nativeImage } = require('electron');
const log = require('electron-log');

// Heavy pixelation blur via scale-down → scale-up.
// Pure Electron nativeImage — no native deps.
function blurImage(img) {
  const { width, height } = img.getSize();
  const tinyW = Math.max(Math.round(width * 0.05), 8);
  const tinyH = Math.max(Math.round(height * 0.05), 8);
  const small = img.resize({ width: tinyW, height: tinyH, quality: 'fast' });
  return small.resize({ width, height, quality: 'good' });
}

// Stitch multiple nativeImages side by side using raw RGBA bitmap data.
// Pure JS — only uses Electron's built-in nativeImage API, no native deps.
function stitchHorizontally(images) {
  const sizes = images.map((img) => img.getSize());
  const totalWidth = sizes.reduce((sum, s) => sum + s.width, 0);
  const maxHeight = Math.max(...sizes.map((s) => s.height));

  const out = Buffer.alloc(totalWidth * maxHeight * 4, 0); // RGBA, black fill

  let xOffset = 0;
  for (let i = 0; i < images.length; i++) {
    const bmp = images[i].getBitmap();
    const { width, height } = sizes[i];
    for (let y = 0; y < height; y++) {
      const srcStart = y * width * 4;
      const dstStart = y * totalWidth * 4 + xOffset * 4;
      bmp.copy(out, dstStart, srcStart, srcStart + width * 4);
    }
    xOffset += width;
  }

  return nativeImage.createFromBitmap(out, { width: totalWidth, height: maxHeight });
}

// Captures all connected displays and stitches them into a single JPEG.
// blurDisplayIds: array of display ID strings whose images should be blurred individually.
// Falls back gracefully to primary-only if multi-monitor capture fails.
async function capturePrimary({ maxWidthPerScreen = 1600, quality = 50, blurDisplayIds = [] } = {}) {
  const blurSet = new Set(blurDisplayIds.map(String));
  const displays = screen.getAllDisplays();

  // Request thumbnails sized to fit within maxWidthPerScreen × reasonable height.
  // Electron scales each source to fit while preserving its aspect ratio.
  const thumbW = maxWidthPerScreen;
  const thumbH = Math.round(maxWidthPerScreen * 0.7); // 10:7 envelope covers 16:9 and 16:10

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbW, height: thumbH },
    });
  } catch (err) {
    throw new Error(`desktopCapturer failed: ${err.message}`);
  }

  if (!sources.length) throw new Error('No screen sources available');

  // Match each display to its source by display_id; fall back to index order.
  const images = [];
  for (let i = 0; i < displays.length; i++) {
    const display = displays[i];
    const match =
      sources.find((s) => s.display_id === String(display.id)) || sources[i];
    if (!match) continue;
    let img = match.thumbnail;
    if (img.isEmpty()) {
      log.warn(`capture: display ${display.id} returned empty thumbnail — skipping`);
      continue;
    }
    // Blur only this display's image if it has a private app on it
    if (blurSet.has(String(display.id))) {
      img = blurImage(img);
      log.debug(`capture: display ${display.id} blurred (private app)`);
    }
    images.push(img);
  }

  if (!images.length) throw new Error('All screen thumbnails are empty (permission denied?)');

  // Stitch if multiple monitors, otherwise use the single image as-is.
  let img = images.length > 1 ? stitchHorizontally(images) : images[0];

  // Downscale if the stitched width exceeds maxWidthPerScreen × number of screens.
  // (Shouldn't normally trigger, but guards against oversized thumbnails.)
  const maxTotalWidth = maxWidthPerScreen * images.length;
  const size = img.getSize();
  if (size.width > maxTotalWidth) {
    const targetH = Math.round((maxTotalWidth / size.width) * size.height);
    img = img.resize({ width: maxTotalWidth, height: targetH, quality: 'good' });
  }

  const finalSize = img.getSize();
  const buffer = img.toJPEG(quality);

  log.debug(
    `capture: ${images.length} display(s) → ${finalSize.width}×${finalSize.height} JPEG (${buffer.length} bytes)${blurSet.size > 0 ? ` [${blurSet.size} blurred]` : ''}`
  );

  return {
    buffer,
    width: finalSize.width,
    height: finalSize.height,
    contentType: 'image/jpeg',
    ext: 'jpg',
  };
}

module.exports = { capturePrimary };
