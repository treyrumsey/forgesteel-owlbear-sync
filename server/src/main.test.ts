import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

// Runs the entry point the way Railway will (plain `node src/main.ts`), which checks that
// the server code only uses TypeScript syntax Node's type stripping supports.
describe('node src/main.ts', () => {
	it('starts, serves /healthz and stops cleanly on SIGTERM', async () => {
		const child = spawn(process.execPath, [ 'src/main.ts' ], {
			cwd: new URL('..', import.meta.url),
			env: { ...process.env, PORT: '0', STUB_DEVICE_TOKENS: 'smoke=Smoke' }
		});

		const port = await new Promise<number>((resolve, reject) => {
			let output = '';
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

		const exitCode = new Promise(resolve => child.on('exit', resolve));
		child.kill('SIGTERM');

		expect(health.version).toMatch(/^1\./);
		expect(await exitCode).toBe(0);
	});
});
