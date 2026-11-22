import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

// Runs the entry point the way Railway will (plain `node src/main.ts`), which checks that
// the server code only uses TypeScript syntax Node's type stripping supports.
describe('node src/main.ts', () => {
	it('migrates a new database file, seeds the dev room, serves /healthz and stops cleanly on SIGTERM', async () => {
		const databasePath = join(mkdtempSync(join(tmpdir(), 'sync-steel-main-')), 'main.db');
		const child = spawn(process.execPath, [ 'src/main.ts' ], {
			cwd: new URL('..', import.meta.url),
			env: { ...process.env, PORT: '0', DATABASE_PATH: databasePath, DEV_SEED: '1', NODE_ENV: 'development' }
		});

		let output = '';
		const port = await new Promise<number>((resolve, reject) => {
			child.stdout.on('data', (chunk: Buffer) => {
				output += chunk.toString();
				const match = /listening on http:\/\/localhost:(\d+)/.exec(output);
				if (match) {
					resolve(Number(match[1]));
				}
			});
			child.stderr.on('data', (chunk: Buffer) => output += chunk.toString());
			child.on('exit', code => reject(new Error(`exited with ${code}: ${output}`)));
		});

		const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
		const connect = await fetch(`http://127.0.0.1:${port}/connect`, { method: 'POST', headers: { Authorization: 'Bearer dev-token' } });

		const exitCode = new Promise(resolve => child.on('exit', resolve));
		child.kill('SIGTERM');

		expect(health.version).toMatch(/^1\./);
		expect(connect.status).toBe(200);
		expect(output).toContain('applied 001-initial.sql');
		expect(output).toContain('Dev room device tokens');
		expect(await exitCode).toBe(0);
	});
});
