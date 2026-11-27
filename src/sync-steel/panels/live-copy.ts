// Makes Sync Steel's live copy of one of upstream's hero drawers from the upstream file (src/sync-steel/panels/).
// The copy is upstream's file with three changes, each marked "Sync Steel:":
// - its export is renamed Live<Name>;
// - its stylesheet is imported from upstream's folder;
// - one line follows changes live sync applies while it's open (live/remote-heroes.ts);
// - for a drawer whose inner panels keep their own copies too, the part holding them is remounted on a remote
//   change, so it shows it: Vitals' HeroHealthPanel on any change, and Inventory's items and notes only when
//   the change touched the inventory (so notes being typed aren't reset by, say, damage). A remount resets
//   only what's typed into that part.
//
// panels.test.ts checks each copy is exactly this, so a change upstream fails the tests (and the daily
// upstream merge's CI) until the copies are made again with:
//
//   node scripts/sync-steel/update-live-panels.ts
//
// Plain TypeScript with no imports, so Node runs it directly.

export interface LivePanel {
	// The folder under src/components/modals/, which is also the file's stem minus "-modal"
	folder: string;
	name: string;
	// The part of the drawer whose upstream panels copy what they show when they mount, remounted on a
	// remote change: the exact opening of its element, and, if only some changes matter, the HeroState fields
	remount?: { open: string, touches?: string[] };
}

export const LIVE_PANEL_COPIES: LivePanel[] = [
	{ folder: 'hero-resources', name: 'HeroResourcesModal' },
	{ folder: 'hero-vitals', name: 'HeroVitalsModal', remount: { open: '<HeroHealthPanel\n' } },
	{
		folder: 'hero-inventory',
		name: 'HeroInventoryModal',
		remount: { open: '<Space orientation=\'vertical\' style={{ width: \'100%\', paddingBottom: \'20px\' }}>', touches: [ 'inventory', 'inventoryText' ] }
	}
];

export const upstreamPath = (panel: LivePanel) => `src/components/modals/${panel.folder}/${panel.folder}-modal.tsx`;
export const copyPath = (panel: LivePanel) => `src/sync-steel/panels/copies/${panel.folder}-modal.tsx`;

const replaceOnce = (source: string, find: string, replacement: string, what: string) => {
	const at = source.indexOf(find);
	if ((at < 0) || (source.indexOf(find, at + 1) >= 0)) {
		throw new Error(`${what}: expected exactly one "${find.trim()}" in upstream's file`);
	}
	return source.slice(0, at) + replacement + source.slice(at + find.length);
};

const remountFollower = (touches?: string[]) => {
	const lines = [
		'\tconst [ remoteChanges, setRemoteChanges ] = useState<number>(0);',
		'\tuseRemoteHero(props.hero.id, remote => {'
	];
	if (touches) {
		lines.push(
			`\t\tconst touched = ([ ${touches.map(field => `'${field}'`).join(', ')} ] as const).some(field => JSON.stringify(remote.state[field]) !== JSON.stringify(hero.state[field]));`,
			'\t\tsetHero(Utils.copy(remote));',
			'\t\tif (touched) {',
			'\t\t\tsetRemoteChanges(count => count + 1);',
			'\t\t}'
		);
	} else {
		lines.push('\t\tsetHero(Utils.copy(remote));', '\t\tsetRemoteChanges(count => count + 1);');
	}
	lines.push('\t});', '');
	return lines.join('\n');
};

export const liveCopy = (panel: LivePanel, upstream: string) => {
	const { folder, name } = panel;
	const what = `${name} live copy`;
	let source = upstream.replace(/\r\n/g, '\n');
	source = replaceOnce(source, `import './${folder}-modal.scss';`,
		`// Sync Steel: upstream's stylesheet, from its own folder\nimport '@/components/modals/${folder}/${folder}-modal.scss';`, what);
	source = replaceOnce(source, `export const ${name} = (props: Props) => {`,
		`// Sync Steel: renamed from ${name}\nexport const Live${name} = (props: Props) => {`, what);
	source = replaceOnce(source, '\tconst [ hero, setHero ] = useState<Hero>(Utils.copy(props.hero));\n',
		'\tconst [ hero, setHero ] = useState<Hero>(Utils.copy(props.hero));\n'
		+ '\t// Sync Steel: follow changes made elsewhere (another device, Owlbear) while this is open\n'
		+ (panel.remount ? remountFollower(panel.remount.touches) : '\tuseRemoteHero(props.hero.id, remote => setHero(Utils.copy(remote)));\n'), what);
	if (panel.remount) {
		const { open } = panel.remount;
		const at = source.indexOf(open);
		const indent = at >= 0 ? source.slice(source.lastIndexOf('\n', at) + 1, at) : '';
		const tag = open.match(/^<\w+/)?.[0] ?? '';
		const keyed = open.endsWith('\n') ? `${tag}\n${indent}\tkey={remoteChanges}\n` : `${tag} key={remoteChanges}${open.slice(tag.length)}`;
		source = replaceOnce(source, open, `{/* Sync Steel: remount this on a remote change, since its panels copy what they show when they mount */}\n${indent}${keyed}`, what);
	}
	source = replaceOnce(source, 'import { useState } from \'react\';\n',
		'// Sync Steel: live sync\'s remote changes\nimport { useRemoteHero } from \'@/sync-steel/live/remote-heroes\';\nimport { useState } from \'react\';\n', what);
	const header = [
		`// Sync Steel's live copy of upstream's ${name} (${upstreamPath(panel)}).`,
		'// Made by src/sync-steel/panels/live-copy.ts: don\'t edit it by hand. Regenerate it with',
		'// node scripts/sync-steel/update-live-panels.ts when upstream changes the original.',
		''
	].join('\n');
	return header + source;
};
