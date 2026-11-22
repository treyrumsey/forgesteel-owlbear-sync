import { Alert, Button, Checkbox, Input, Space, Typography } from 'antd';
import { CreatedRoom, SyncSteelRoomApi } from '@/sync-steel/api/sync-steel-api';
import { useMemo, useState } from 'react';
import { HeaderText } from '@/components/controls/header-text/header-text';
import { SyncSteelConnection } from '@/sync-steel/logic/sync-steel-connection';

interface Props {
	host: string;
	onJoined: (deviceToken: string) => Promise<void>;
}

export const SyncSteelCreateRoomPanel = (props: Props) => {
	const api = useMemo(() => new SyncSteelRoomApi(props.host), [ props.host ]);
	const [ roomName, setRoomName ] = useState<string>('');
	const [ gmSeatName, setGmSeatName ] = useState<string>('GM');
	const [ deviceLabel, setDeviceLabel ] = useState<string>(() => SyncSteelConnection.defaultDeviceLabel(window.navigator.userAgent));
	const [ created, setCreated ] = useState<CreatedRoom | null>(null);
	const [ saved, setSaved ] = useState<boolean>(false);
	const [ busy, setBusy ] = useState<boolean>(false);
	const [ error, setError ] = useState<string | null>(null);

	const create = async () => {
		setBusy(true);
		setError(null);
		try {
			setCreated(await api.createRoom(roomName.trim(), gmSeatName.trim(), deviceLabel.trim()));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const finish = async () => {
		if (!created) {
			return;
		}
		setBusy(true);
		try {
			await props.onJoined(created.deviceToken);
		} finally {
			setBusy(false);
		}
	};

	if (created) {
		return (
			<Space orientation='vertical' style={{ width: '100%' }} size='middle'>
				<HeaderText level={2}>{created.room.name} is ready</HeaderText>
				<Alert
					type='warning'
					showIcon={true}
					title='Save these now'
					description='The server keeps only scrambled copies, so neither can be shown again. You can rotate the join code later from the GM tools; the GM key can never be changed or recovered.'
				/>
				<div>
					<div className='ds-text'><b>Join code</b>: give this to your players.</div>
					<Typography.Text className='sync-steel-secret' copyable={true}>{created.joinCode}</Typography.Text>
				</div>
				<div>
					<div className='ds-text'><b>GM key</b>: keep this private, in a password manager. You need it to add more GM devices.</div>
					<Typography.Text className='sync-steel-secret' copyable={true}>{created.gmKey}</Typography.Text>
				</div>
				<Checkbox checked={saved} onChange={e => setSaved(e.target.checked)}>I've saved the join code and the GM key</Checkbox>
				<Button type='primary' disabled={!saved} loading={busy} onClick={finish}>Continue</Button>
			</Space>
		);
	}

	return (
		<Space orientation='vertical' style={{ width: '100%' }} size='middle'>
			<div className='ds-text'>
				The GM creates the room once. You'll get a <b>join code</b> for the players and a <b>GM key</b> for yourself, and this device joins the GM's seat.
			</div>
			<Input placeholder='Room name, such as "Thursday group"' maxLength={60} value={roomName} onChange={e => setRoomName(e.target.value)} />
			<Space orientation='vertical' style={{ width: '100%' }}>
				<div className='ds-text'>The GM's seat name:</div>
				<Input maxLength={60} value={gmSeatName} onChange={e => setGmSeatName(e.target.value)} />
			</Space>
			<Space orientation='vertical' style={{ width: '100%' }}>
				<div className='ds-text'>This device's name:</div>
				<Input maxLength={80} value={deviceLabel} onChange={e => setDeviceLabel(e.target.value)} />
			</Space>
			{error ? <Alert type='error' showIcon={true} title={error} /> : null}
			<Button type='primary' disabled={busy || !roomName.trim() || !gmSeatName.trim() || !deviceLabel.trim()} loading={busy} onClick={create}>
				Create room
			</Button>
		</Space>
	);
};
