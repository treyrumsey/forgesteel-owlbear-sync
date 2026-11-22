import { DatabaseSync } from 'node:sqlite';
import { buildRoomExport } from '../room-export.ts';
import { createServices } from '../services.ts';
import { gzipSync } from 'node:zlib';

// Writes a room export, the same file GET /gm/export downloads, from a database file such as a snapshot.
// The GM restores it with the import endpoint. Over `railway ssh`, use --base64 and decode locally:
//   railway ssh -- node src/tools/export-room.ts /data/snapshots/sync-steel-2026-11-22.db --base64 | base64 --decode > room.json.gz

const args = process.argv.slice(2);
const base64 = args.includes('--base64');
const [ path, roomQuery ] = args.filter(arg => arg !== '--base64');

const stop = (message: string) => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

if (!path) {
	stop('Usage: node src/tools/export-room.ts <database file> [room name or id] [--base64]');
}

const db = new DatabaseSync(path, { readOnly: true });
const rooms = db.prepare('SELECT id, name FROM rooms ORDER BY created_at').all() as { id: string, name: string }[];
const matches = roomQuery
	? rooms.filter(room => (room.id === roomQuery) || (room.name.toLowerCase() === roomQuery.toLowerCase()))
	: rooms;
if (matches.length !== 1) {
	const list = rooms.map(room => `  ${room.id}  ${room.name}`).join('\n');
	stop(`${matches.length === 0 ? 'No room matches' : 'Several rooms match'}; name one of these:\n${list}`);
}

// Exporting only reads, so the secrets are never used
const services = createServices({ db: db, secrets: { jwt: 'unused-jwt', jwtRefresh: 'unused-refresh', tokenHash: 'unused-hash' } });
const payload = buildRoomExport(services, matches[0].id);
const file = gzipSync(JSON.stringify(payload));
process.stdout.write(base64 ? `${file.toString('base64')}\n` : file);
process.stderr.write(`Exported room "${payload.room.name}": ${payload.seats.length} seats, ${payload.heroes.length} heroes, ${payload.homebrew.length} homebrew\n`);
db.close();
