import { ButtonConfig } from '@/components/controls/button-group/button-group';
import { SyncOutlined } from '@ant-design/icons';

// The footer's Sync Steel button, added to upstream's footer with one line (app-footer.tsx)
export const syncSteelFooterAction = (isSmall: boolean): ButtonConfig => ({
	type: 'button',
	label: isSmall ? undefined : 'Sync Steel',
	icon: <SyncOutlined />,
	tooltip: 'Sync Steel: join your group\'s room',
	onClick: () => {
		window.location.hash = '#/sync-steel';
	}
});
