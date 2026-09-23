import path from 'node:path';
import { access } from 'node:fs/promises';
import express, { Router, type RequestHandler } from 'express';
import { SyncServerConfigError } from './config.js';

const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', DASHBOARD_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}

export async function assertDashboardAssets(dashboardDistDir: string): Promise<void> {
  try {
    await access(path.join(dashboardDistDir, 'index.html'));
  } catch {
    throw new SyncServerConfigError(
      `Dashboard assets are missing from the configured directory: ${dashboardDistDir}`,
    );
  }
}

export function createDashboardRouter(dashboardDistDir: string): Router {
  const router = Router();
  const indexPath = path.join(dashboardDistDir, 'index.html');

  router.use(securityHeaders());
  router.use(
    '/assets',
    express.static(path.join(dashboardDistDir, 'assets'), {
      dotfiles: 'deny',
      fallthrough: false,
      immutable: true,
      maxAge: '1y',
    }),
  );

  router.get(['/', '/*'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexPath, (error) => {
      if (error) {
        next(error);
      }
    });
  });

  return router;
}
