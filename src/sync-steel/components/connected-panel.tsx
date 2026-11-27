import { Alert, Button, Popconfirm, Space, Spin } from 'antd';
import { Me, SyncSteelApiError, SyncSteelDeviceApi } from '@/sync-steel/api/sync-steel-api';
import { useEffect, useMemo, useState } from 'react';
import { HeaderText } from '@/components/controls/header-text/header-text';
import { SyncSteelGmPanel } from '@/sync-steel/components/gm-panel';
import { SyncSteelLivePanelsSetting } from '@/sync-steel/components/live-panels-setting';
import { useNavigation } from '@/hooks/use-navigation';

interface Props {
	host: string;
	deviceToken: string;
	onDisconnect: () => Promise<void>;
}

export const SyncSteelConnectedPanel = (props: Props) => {
	const navigation = useNavigation();
	const api = useMemo(() => new SyncSteelDeviceApi(props.host, props.deviceToken), [ props.host, props.deviceToken ]);
	const [ me, setMe ] = useState<Me | null>(null);
	const [ error, setError ] = useState<SyncSteelApiError | Error | null>(null);
	const [ busy, setBusy ] = useState<boolean>(false);

	useEffect(() => {
		api.me().then(setMe, setError);
	}, [ api ]);

	const disconnect = async () => {
		setBusy(true);
		try {
			await props.onDisconnect();
		} finally {
			setBusy(false);
		}
	};

	const disconnectButton = (
		<Popconfirm
			title='Disconnect this browser?'
			description='It goes back to its own local storage. Your heroes stay on the server: join again to get them back.'
			okText='Disconnect'
			onConfirm={disconnect}
		>
			<Button loading={busy}>Disconnect this browser</Button>
		</Popconfirm>
	);

	if (error) {
		const revoked = (error instanceof SyncSteelApiError) && (error.status === 401);
		return (
			<Space orientation='vertical' style={{ width: '100%' }} size='middle'>
				<Alert
					type={revoked ? 'warning' : 'error'}
					showIcon={true}
					title={revoked ? 'This device was disconnected from the room' : 'Couldn\'t reach the room'}
					description={revoked ? 'The GM disconnected it, or the server was reset. Disconnect, then join again with the code: pick your seat and your heroes come back.' : error.message}
				/>
				{disconnectButton}
			</Space>
		);
	}

	if (!me) {
		return <Spin />;
	}

	return (
		<Space orientation='vertical' style={{ width: '100%' }} size='large'>
			<Space orientation='vertical' style={{ width: '100%' }}>
				<HeaderText level={1}>{me.room.name}</HeaderText>
				<Alert
					type='success'
					showIcon={true}
					title={<>Connected as <b>{me.seat.name}</b>{me.seat.isGm && (me.seat.name !== 'GM') ? ' (GM)' : ''}</>}
					description='Your heroes and homebrew are saved to the room, so they come back on any device that joins your seat.'
				/>
			</Space>
			<Space orientation='vertical' style={{ width: '100%' }}>
				<HeaderText level={2}>Next steps</HeaderText>
				<ol className='sync-steel-steps'>
					<li>
						<b>Bring your heroes:</b> export them from forgesteel.net as <code>.ds-hero</code> files, then here open <b>Heroes</b> → <b>Add</b> → <b>Import Hero Files</b>.
					</li>
					<li>
						<b>Homebrew:</b> export <code>.ds-sourcebook</code> files from forgesteel.net, then here open <b>Library</b> → <b>Sourcebooks</b> → <b>Import a sourcebook</b>.
					</li>
					<li>
						<b>On iPad or iPhone:</b> tap <b>Share</b> → <b>Add to Home Screen</b> to install Sync Steel as an app.
					</li>
				</ol>
				<Space>
					<Button type='primary' onClick={() => navigation.goToHeroList()}>Go to Heroes</Button>
					{disconnectButton}
				</Space>
			</Space>
			<SyncSteelLivePanelsSetting />
			{me.seat.isGm ? <SyncSteelGmPanel api={api} /> : null}
		</Space>
	);
};
