import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDashboardRouter } from '../src/dashboardStatic.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ariadne-dashboard-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Ariadne Operations</title>');
  await writeFile(path.join(root, 'assets', 'app-abc123.js'), 'console.info("dashboard")');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('serves the dashboard shell and nested client routes without caching HTML', async () => {
  const app = express();
  app.use('/admin', createDashboardRouter(root));

  const rootResponse = await request(app).get('/admin').expect(200);
  expect(rootResponse.text).toContain('Ariadne Operations');
  expect(rootResponse.headers['cache-control']).toContain('no-cache');

  const nested = await request(app).get('/admin/tasks/task-1').expect(200);
  expect(nested.text).toContain('Ariadne Operations');
});

it('serves hashed assets immutably and applies browser security headers', async () => {
  const app = express();
  app.use('/admin', createDashboardRouter(root));

  const response = await request(app).get('/admin/assets/app-abc123.js').expect(200);
  expect(response.headers['cache-control']).toContain('immutable');
  expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  expect(response.headers['x-frame-options']).toBe('DENY');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
});
