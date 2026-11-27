import { type ComponentProps } from 'react';
import { LiveHeroInventoryModal } from '@/sync-steel/panels/copies/hero-inventory-modal';
import { LivePanels } from '@/sync-steel/panels/live-panels';
import { HeroInventoryModal as UpstreamHeroInventoryModal } from '@/components/modals/hero-inventory/hero-inventory-modal';

// What the branded build gives every importer of upstream's HeroInventoryModal (src/sync-steel/build/live-panels.ts):
// Sync Steel's live copy while the Live panels switch is on, otherwise upstream's original, untouched.
export const HeroInventoryModal = (props: ComponentProps<typeof UpstreamHeroInventoryModal>) => {
	return LivePanels.isOn() ? <LiveHeroInventoryModal {...props} /> : <UpstreamHeroInventoryModal {...props} />;
};
