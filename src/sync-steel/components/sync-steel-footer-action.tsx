import { ButtonConfig } from '@/components/controls/button-group/button-group';
import { SyncSteelStatusIcon } from '@/sync-steel/live/sync-steel-status';

// The footer's Sync Steel button, added to upstream's footer with one line (app-footer.tsx)
export const syncSteelFooterAction = (isSmall: boolean): ButtonConfig => ({
	type: 'button',
	label: isSmall ? undefined : 'Sync Steel',
	icon: <SyncSteelStatusIcon />,
	tooltip: 'Sync Steel: join your group\'s room',
	onClick: () => {
		window.location.hash = '#/sync-steel';
	}
});
