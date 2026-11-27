import { type ComponentProps } from 'react';
import { LiveHeroResourcesModal } from '@/sync-steel/panels/copies/hero-resources-modal';
import { LivePanels } from '@/sync-steel/panels/live-panels';
import { HeroResourcesModal as UpstreamHeroResourcesModal } from '@/components/modals/hero-resources/hero-resources-modal';

// What the branded build gives every importer of upstream's HeroResourcesModal (src/sync-steel/build/live-panels.ts):
// Sync Steel's live copy while the Live panels switch is on, otherwise upstream's original, untouched.
export const HeroResourcesModal = (props: ComponentProps<typeof UpstreamHeroResourcesModal>) => {
	return LivePanels.isOn() ? <LiveHeroResourcesModal {...props} /> : <UpstreamHeroResourcesModal {...props} />;
};
