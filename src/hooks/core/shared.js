// src/hooks/core/shared.js — Shared utilities for core hook modules.
//
// Extracted from activate.js and deactivate.js to avoid duplication.
// Exports: request, post, get, put, detectTls, resolvePort, stateDir
//
// Provider-agnostic. Pure stdlib, CommonJS, Node ≥14.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');

// ── State dir ────────────────────────────────────────────────────────────

function stateDir() {
  return process.env.AIRPROMPT_STATE_DIR || path.join(os.homedir(), '.airprompt', 'state');
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

/**
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} urlPath
 * @param {object|null} body
 * @param {number} port
 * @param {boolean} tls
 * @param {{ timeout?: number, nullOnParseError?: boolean }} [opts]
 */
function request(method, urlPath, body, port, tls, opts) {
  const timeout = (opts && opts.timeout) || 3000;
  const nullOnParseError = opts && opts.nullOnParseError;
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = body
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      : {};
    const reqOpts = {
      hostname: 'localhost', port, path: urlPath, method,
      headers, timeout,
    };
    const mod = tls ? https : http;
    if (tls) reqOpts.rejectUnauthorized = false;
    const req = mod.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve(nullOnParseError ? null : { raw: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.on('error', reject);
    if (body) req.write(payload);
    req.end();
  });
}

function post(p, body, port, tls, opts) { return request('POST', p, body, port, tls, opts); }
function get(p, port, tls, opts) { return request('GET', p, null, port, tls, opts); }
function put(p, body, port, tls, opts) { return request('PUT', p, body, port, tls, opts); }

// ── TLS detection ────────────────────────────────────────────────────────

function detectTls() {
  if (process.env.AIRPROMPT_NO_TLS === '1') return false;
  const sd = stateDir();
  // daemon.json is the SSOT for the running daemon's protocol.
  // Cert files are the fallback (daemon not yet started or daemon.json stale).
  const dj = path.join(sd, 'daemon.json');
  try {
    if (fs.existsSync(dj)) {
      const info = JSON.parse(fs.readFileSync(dj, 'utf8'));
      return info.protocol === 'https';
    }
  } catch (_) {}
  const certFile = path.join(sd, 'airprompt-cert.pem');
  const keyFile = path.join(sd, 'airprompt-key.pem');
  return fs.existsSync(certFile) && fs.existsSync(keyFile);
}

// ── Port resolution ──────────────────────────────────────────────────────

function resolvePort() {
  const sd = stateDir();
  try {
    const dj = path.join(sd, 'daemon.json');
    if (fs.existsSync(dj)) {
      const info = JSON.parse(fs.readFileSync(dj, 'utf8'));
      if (info.port) return info.port;
    }
  } catch (_) {}
  return parseInt(process.env.AIRPROMPT_PORT || '3210', 10);
}

module.exports = { request, post, get, put, detectTls, resolvePort, stateDir };
