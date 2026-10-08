import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { openPublicBrandingFile } from '../services/file-store';

export const router = Router();

/**
 * GET /api/public/branding/settings/logo-<n>.<ext> — the company logo.
 *
 * UNAUTHENTICATED by design: `settings.logo_url` is rendered on the login page
 * and inlined into printed receipts, neither of which has a session. It is the
 * S3 driver's stand-in for Supabase's public `branding` bucket, and serves
 * nothing but a path shaped like a logo (see LOGO_PATH_PATTERN).
 *
 * Two headers do real work here:
 *
 *   Cross-Origin-Resource-Policy: cross-origin
 *     helmet's default is `same-origin`, under which the web app — a different
 *     origin from this API — could not show the image at all.
 *   Cache-Control: immutable
 *     the file name carries its upload timestamp and is never rewritten, so a
 *     browser need fetch it once. A new logo is a new URL.
 */
router.get('/*', async (req, res, next) => {
  try {
    const path = (req.params as Record<string, string>)['0'] ?? '';
    const file = await openPublicBrandingFile(path);
    if (!file) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.setHeader('Content-Type', file.contentType);
    if (file.contentLength !== null) res.setHeader('Content-Length', String(file.contentLength));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // An SVG is a document, not just a picture. Opened directly it would run
    // any script inside it on this API's origin; this forbids that.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await pipeline(file.body, res);
  } catch (err) {
    if (res.headersSent) res.destroy();
    else next(err);
  }
});
