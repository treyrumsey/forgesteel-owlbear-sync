// Sync Steel's live copy of upstream's HeroVitalsModal (src/components/modals/hero-vitals/hero-vitals-modal.tsx).
// Made by src/sync-steel/panels/live-copy.ts: don't edit it by hand. Regenerate it with
// node scripts/sync-steel/update-live-panels.ts when upstream changes the original.
import { ExtractedCondition } from '@/logic/condition-extraction-logic';
import { Hero } from '@/models/hero';
import { HeroHealthPanel } from '@/components/panels/health/health-panel';
import { Modal } from '@/components/modals/modal/modal';
import { Utils } from '@/utils/utils';
// Sync Steel: live sync's remote changes
import { useRemoteHero } from '@/sync-steel/live/remote-heroes';
import { useState } from 'react';

// Sync Steel: upstream's stylesheet, from its own folder
import '@/components/modals/hero-vitals/hero-vitals-modal.scss';

interface Props {
	hero: Hero;
	showEncounterControls: boolean;
	encounterConditions?: ExtractedCondition[];
	onClose: () => void;
	onChange: (hero: Hero) => void;
}

// Sync Steel: renamed from HeroVitalsModal
export const LiveHeroVitalsModal = (props: Props) => {
	const [ hero, setHero ] = useState<Hero>(Utils.copy(props.hero));
	// Sync Steel: follow changes made elsewhere (another device, Owlbear) while this is open
	const [ remoteChanges, setRemoteChanges ] = useState<number>(0);
	useRemoteHero(props.hero.id, remote => {
		setHero(Utils.copy(remote));
		setRemoteChanges(count => count + 1);
	});

	const onChange = (hero: Hero) => {
		setHero(hero);
		props.onChange(hero);
	};

	return (
		<Modal
			content={
				<div className='hero-vitals-modal'>
					{/* Sync Steel: remount this on a remote change, since its panels copy what they show when they mount */}
					<HeroHealthPanel
						key={remoteChanges}
						hero={hero}
						showEncounterControls={props.showEncounterControls}
						encounterConditions={props.encounterConditions}
						onChange={onChange}
					/>
				</div>
			}
			onClose={props.onClose}
		/>
	);
};
