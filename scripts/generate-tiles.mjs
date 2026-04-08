#!/usr/bin/env node
/**
 * generate-tiles.mjs — Slice gamemap.png into a Leaflet tile pyramid
 *
 * Generates WebP tiles at three zoom levels corresponding to Leaflet zooms
 * -2, -1, and 0 (stored as file z=0, 1, 2 via zoomOffset=2 in the TileLayer).
 *
 * Output: public/tiles/{z}/{x}/{y}.webp
 *
 * Usage:
 *   npm run generate-tiles
 *   node scripts/generate-tiles.mjs
 *
 * Requires: sharp  (npm install --save-dev sharp)
 *
 * Tile coordinate convention: tms=true (y=0 is the BOTTOM tile row)
 * This is required for L.CRS.Simple because its transformation makes
 * standard (tms=false) tile y values negative, which don't map to filenames.
 * With tms=true, Leaflet inverts y so all tile indices are non-negative.
 *
 * File y=0          → bottom of image (game Y near 6144, lat=0)
 * File y=(tilesY-1) → top of image    (game Y near 0,    lat=6144)
 * imageRow = (tilesY - 1) - tileY
 */

import sharp from 'sharp';
import { mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const IMAGE_PATH = path.join(ROOT, 'public', 'gamemap.png');
const OUTPUT_DIR = path.join(ROOT, 'public', 'tiles');
const TILE_SIZE  = 256;
const WEBP_QUALITY = 80;

// Source image dimensions (must match the actual file)
const IMG_W = 10752;
const IMG_H = 6144;

/**
 * Zoom levels to generate.
 * file z = Leaflet zoom + 2   (zoomOffset: 2 in the TileLayer)
 *
 * srcTileW/srcTileH = how many source image pixels each 256px output tile covers.
 * At Leaflet zoom -2: each tile covers 1024 source px  → 11×6  tiles
 * At Leaflet zoom -1: each tile covers 512  source px  → 21×12 tiles
 * At Leaflet zoom  0: each tile covers 256  source px  → 42×24 tiles (native)
 */
const ZOOM_LEVELS = [
    { leafletZoom: -2, fileZ: 0, srcTileW: 1024, srcTileH: 1024 },
    { leafletZoom: -1, fileZ: 1, srcTileW: 512,  srcTileH: 512  },
    { leafletZoom:  0, fileZ: 2, srcTileW: 256,  srcTileH: 256  },
];

// ---------------------------------------------------------------------------

console.log(`Loading ${IMAGE_PATH} into memory...`);
const { data, info } = await sharp(IMAGE_PATH)
    .raw()
    .toBuffer({ resolveWithObject: true });

const { width, height, channels } = info;
console.log(`Loaded: ${width}×${height}, ${channels} channels (${(data.length / 1024 / 1024).toFixed(0)} MB raw)`);

if (width !== IMG_W || height !== IMG_H) {
    console.warn(`Warning: expected ${IMG_W}×${IMG_H} but got ${width}×${height}. Continuing anyway.`);
}

const rowBytes = width * channels;

let totalTiles = 0;

for (const { leafletZoom, fileZ, srcTileW, srcTileH } of ZOOM_LEVELS) {
    const tilesX = Math.ceil(IMG_W / srcTileW);
    const tilesY = Math.ceil(IMG_H / srcTileH);
    const count  = tilesX * tilesY;
    totalTiles  += count;
    console.log(`\nZoom ${leafletZoom >= 0 ? ' ' : ''}${leafletZoom} (file z=${fileZ}): ${tilesX}×${tilesY} = ${count} tiles  [src ${srcTileW}px/tile]`);

    let done = 0;
    const t0 = Date.now();

    for (let tx = 0; tx < tilesX; tx++) {
        for (let tileY = 0; tileY < tilesY; tileY++) {
            // TMS convention: y=0 is the BOTTOM row.
            // imageRow=0 is the TOP of the PNG (pixel y=0).
            // Mapping: imageRow = (tilesY - 1) - tileY
            const imageRow = (tilesY - 1) - tileY;

            const srcLeft   = tx * srcTileW;
            const srcTop    = imageRow * srcTileH;
            const srcWidth  = Math.min(srcTileW, IMG_W - srcLeft);
            const srcHeight = Math.min(srcTileH, IMG_H - srcTop);

            // Copy the source region into a padded srcTileW×srcTileH raw buffer.
            // Padding (with zeros = black) handles edge tiles that are narrower
            // than srcTileW / srcTileH without distorting the aspect ratio.
            const rawBuf = Buffer.alloc(srcTileW * srcTileH * channels, 0);

            for (let row = 0; row < srcHeight; row++) {
                const srcOffset = (srcTop + row) * rowBytes + srcLeft * channels;
                const dstOffset = row * srcTileW * channels;
                data.copy(rawBuf, dstOffset, srcOffset, srcOffset + srcWidth * channels);
            }

            // Resize the padded region to TILE_SIZE×TILE_SIZE and encode as WebP.
            const outDir  = path.join(OUTPUT_DIR, String(fileZ), String(tx));
            const outFile = path.join(outDir, `${tileY}.webp`);

            await mkdir(outDir, { recursive: true });

            await sharp(rawBuf, { raw: { width: srcTileW, height: srcTileH, channels } })
                .resize(TILE_SIZE, TILE_SIZE, { kernel: sharp.kernel.lanczos3 })
                .webp({ quality: WEBP_QUALITY })
                .toFile(outFile);

            done++;
            if (done % 50 === 0 || done === count) {
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                process.stdout.write(`  ${done}/${count} tiles  (${elapsed}s)\r`);
            }
        }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ${count}/${count} tiles  (${elapsed}s)          `);
}

console.log(`\nDone — ${totalTiles} tiles written to public/tiles/`);
console.log('Deploy with: npm run deploy');
