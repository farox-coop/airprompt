// public/upload-resize.js — Downscale an image before upload.
//
// The vision API downscales to a 1568px long edge and many-image requests
// reject anything above 2000px, so shipping a 4000px screenshot costs upload
// time and gains nothing. PNG stays PNG (UI screenshots keep crisp text) and
// anything undecodable — HEIC, exotic formats — is passed through untouched
// rather than failing the upload.

(function () {
  'use strict';

  const MAX_EDGE = 1568;
  const JPEG_QUALITY = 0.92;
  // GIF is excluded: canvas would flatten an animation to its first frame.
  const RESIZABLE = ['image/png', 'image/jpeg', 'image/webp'];

  function extFor(mime) {
    return mime === 'image/png' ? '.png' : '.jpg';
  }

  function replaceExt(name, mime) {
    return String(name || 'image').replace(/\.[A-Za-z0-9]+$/, '') + extFor(mime);
  }

  // Untouched passthrough — the file is already fine, or cannot be decoded.
  function pass(file, mime) {
    return { blob: file, name: file.name, mime: mime || 'application/octet-stream' };
  }

  /**
   * @param {File} file
   * @returns {Promise<{blob: Blob|File, name: string, mime: string}>}
   */
  function prepare(file) {
    const mime = file.type || '';
    if (RESIZABLE.indexOf(mime) === -1) return Promise.resolve(pass(file, mime));

    return createImageBitmap(file, { imageOrientation: 'from-image' })
      .then(function (bitmap) {
        const longEdge = Math.max(bitmap.width, bitmap.height);
        if (longEdge <= MAX_EDGE) {
          if (bitmap.close) bitmap.close();
          return pass(file, mime);
        }
        const scale = MAX_EDGE / longEdge;
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const outMime = mime === 'image/png' ? 'image/png' : 'image/jpeg';

        return new Promise(function (resolve) {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
          canvas.toBlob(
            function (blob) {
              if (bitmap.close) bitmap.close();
              // A re-encode that is not actually smaller (an already-optimized
              // JPEG, a small PNG) is worse than the original.
              if (!blob || blob.size >= file.size) resolve(pass(file, mime));
              else resolve({ blob: blob, name: replaceExt(file.name, outMime), mime: outMime });
            },
            outMime,
            JPEG_QUALITY
          );
        });
      })
      .catch(function () {
        return pass(file, mime);
      });
  }

  window.UploadResize = { prepare: prepare, MAX_EDGE: MAX_EDGE };
})();
