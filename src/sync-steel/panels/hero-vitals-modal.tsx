import { type ComponentProps } from 'react';
import { LiveHeroVitalsModal } from '@/sync-steel/panels/copies/hero-vitals-modal';
import { LivePanels } from '@/sync-steel/panels/live-panels';
import { HeroVitalsModal as UpstreamHeroVitalsModal } from '@/components/modals/hero-vitals/hero-vitals-modal';

// What the branded build gives every importer of upstream's HeroVitalsModal (src/sync-steel/build/live-panels.ts):
// Sync Steel's live copy while the Live panels switch is on, otherwise upstream's original, untouched.
export const HeroVitalsModal = (props: ComponentProps<typeof UpstreamHeroVitalsModal>) => {
	return LivePanels.isOn() ? <LiveHeroVitalsModal {...props} /> : <UpstreamHeroVitalsModal {...props} />;
};
