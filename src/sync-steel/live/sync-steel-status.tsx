import { SyncOutlined } from '@ant-design/icons';
import { theme } from 'antd';
import { useSyncSteelStatus } from '@/sync-steel/live/sync-steel-provider';

const LABELS = {
	off: '',
	connecting: 'Connecting to your room…',
	live: 'Live: changes from other devices appear as they\'re saved',
	offline: 'Not connected: reconnecting'
};

// The footer button's icon: a dot shows whether live sync is connected, when this browser is in a room
export const SyncSteelStatusIcon = () => {
	const status = useSyncSteelStatus();
	const { token } = theme.useToken();
	if (status === 'off') {
		return <SyncOutlined />;
	}
	return (
		<span style={{ position: 'relative', display: 'inline-flex' }} title={LABELS[status]} aria-label={LABELS[status]}>
			<SyncOutlined spin={status === 'connecting'} />
			<span
				data-sync-steel-status={status}
				style={{
					position: 'absolute',
					right: -3,
					bottom: -3,
					width: 7,
					height: 7,
					borderRadius: '50%',
					background: status === 'live' ? token.colorSuccess : token.colorTextQuaternary,
					boxShadow: `0 0 0 1.5px ${token.colorBgContainer}`
				}}
			/>
		</span>
	);
};
