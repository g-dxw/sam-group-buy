import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The journal is a small durable outbox, not a second order database. Prices
// stay in Feishu; the payload contains only a catalog-version hash.
export class Journal {
  constructor({ path = '.data/submissions.sqlite' } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS submissions (
        batch_code TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'ready',
        create_settled INTEGER NOT NULL DEFAULT 1,
        acknowledged_json TEXT NOT NULL DEFAULT '[]',
        error_json TEXT,
        submitted_at TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_check_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (batch_code, submission_id)
      );
      CREATE INDEX IF NOT EXISTS unfinished_batch
        ON submissions (batch_code, status, created_at);
    `);
  }

  get(batchCode, submissionId) {
    return this.decode(this.db.prepare(
      'SELECT * FROM submissions WHERE batch_code = ? AND submission_id = ?',
    ).get(batchCode, submissionId));
  }

  insert(entry) {
    const now = entry.createdAt ?? Date.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO submissions
        (batch_code, submission_id, payload_hash, payload_json, status, phase,
         create_settled, acknowledged_json, error_json, submitted_at,
         created_at, updated_at, next_check_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.batchCode, entry.submissionId, entry.payloadHash,
      JSON.stringify(entry.payload), entry.status ?? 'pending', entry.phase ?? 'ready',
      entry.createSettled === false ? 0 : 1, JSON.stringify(entry.acknowledgedLineIds ?? []),
      entry.error ? JSON.stringify(entry.error) : null,
      entry.submittedAt ?? new Date(now).toISOString(), now, now, entry.nextCheckAt ?? 0,
    );
    return result.changes === 1;
  }

  update(batchCode, submissionId, patch) {
    const allowed = {
      status: 'status', phase: 'phase', createSettled: 'create_settled',
      acknowledgedLineIds: 'acknowledged_json', error: 'error_json',
      nextCheckAt: 'next_check_at',
    };
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed[key]) throw new Error(`Unsupported journal update: ${key}`);
      assignments.push(`${allowed[key]} = ?`);
      if (key === 'createSettled') values.push(value ? 1 : 0);
      else if (key === 'acknowledgedLineIds') values.push(JSON.stringify(value));
      else if (key === 'error') values.push(value ? JSON.stringify(value) : null);
      else values.push(value);
    }
    if (assignments.length) {
      assignments.push('updated_at = ?');
      values.push(Date.now(), batchCode, submissionId);
      this.db.prepare(`UPDATE submissions SET ${assignments.join(', ')}
        WHERE batch_code = ? AND submission_id = ?`).run(...values);
    }
    return this.get(batchCode, submissionId);
  }

  listUnfinished(batchCodes) {
    const rows = this.db.prepare(`SELECT * FROM submissions
      WHERE status NOT IN ('completed', 'failed') ORDER BY created_at, rowid`).all();
    const allowed = batchCodes ? new Set(batchCodes) : null;
    return rows.filter((row) => !allowed || allowed.has(row.batch_code)).map((row) => this.decode(row));
  }

  decode(row) {
    if (!row) return null;
    return {
      batchCode: row.batch_code, submissionId: row.submission_id,
      payloadHash: row.payload_hash, payload: JSON.parse(row.payload_json),
      status: row.status, phase: row.phase, createSettled: Boolean(row.create_settled),
      acknowledgedLineIds: JSON.parse(row.acknowledged_json),
      error: row.error_json ? JSON.parse(row.error_json) : null,
      submittedAt: row.submitted_at, createdAt: row.created_at,
      updatedAt: row.updated_at, nextCheckAt: row.next_check_at,
    };
  }

  close() { this.db.close(); }
}
