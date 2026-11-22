import { Alert, Button, Flex, Input, Radio, Space } from 'antd';
import { JoinRequest, RoomLookup, SyncSteelRoomApi } from '@/sync-steel/api/sync-steel-api';
import { useMemo, useState } from 'react';
import { HeaderText } from '@/components/controls/header-text/header-text';
import { SyncSteelConnection } from '@/sync-steel/logic/sync-steel-connection';

interface Props {
	host: string;
	onJoined: (deviceToken: string) => Promise<void>;
}

const NEW_SEAT = 'new';

export const SyncSteelJoinPanel = (props: Props) => {
	const api = useMemo(() => new SyncSteelRoomApi(props.host), [ props.host ]);
	const [ mode, setMode ] = useState<'code' | 'gm-key'>('code');
	const [ code, setCode ] = useState<string>('');
	const [ lookup, setLookup ] = useState<RoomLookup | null>(null);
	const [ seatId, setSeatId ] = useState<string>(NEW_SEAT);
	const [ newSeatName, setNewSeatName ] = useState<string>('');
	const [ gmKey, setGmKey ] = useState<string>('');
	const [ deviceLabel, setDeviceLabel ] = useState<string>(() => SyncSteelConnection.defaultDeviceLabel(window.navigator.userAgent));
	const [ busy, setBusy ] = useState<boolean>(false);
	const [ error, setError ] = useState<string | null>(null);

	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const findRoom = () => run(async () => {
		const result = await api.lookup(code.trim());
		setLookup(result);
		setSeatId(NEW_SEAT);
	});

	const selectedSeat = lookup?.seats.find(s => s.id === seatId) ?? null;

	const join = () => run(async () => {
		const request: JoinRequest = { deviceLabel: deviceLabel.trim() };
		if (mode === 'gm-key') {
			request.gmKey = gmKey.trim();
		} else {
			request.code = code.trim();
			if (seatId === NEW_SEAT) {
				request.newSeatName = newSeatName.trim();
			} else {
				request.seatId = seatId;
				if (selectedSeat?.isGm) {
					request.gmKey = gmKey.trim();
				}
			}
		}
		const joined = await api.join(request);
		await props.onJoined(joined.deviceToken);
	});

	const seatReady = (seatId === NEW_SEAT) ? !!newSeatName.trim() : (!selectedSeat?.isGm || !!gmKey.trim());
	const modeReady = (mode === 'gm-key') ? !!gmKey.trim() : (!!lookup && seatReady);
	const canJoin = !busy && !!deviceLabel.trim() && modeReady;

	const deviceField = (
		<Space orientation='vertical' style={{ width: '100%' }}>
			<div className='ds-text'>This device's name, which the GM sees in the device list:</div>
			<Input value={deviceLabel} maxLength={80} onChange={e => setDeviceLabel(e.target.value)} />
		</Space>
	);

	if (mode === 'gm-key') {
		return (
			<Space orientation='vertical' style={{ width: '100%' }} size='middle'>
				<div className='ds-text'>
					Adding a device for the GM? Enter the room's <b>GM key</b>. You don't need the join code.
				</div>
				<Input.Password placeholder='GM key' value={gmKey} onChange={e => setGmKey(e.target.value)} />
				{deviceField}
				{error ? <Alert type='error' showIcon={true} title={error} /> : null}
				<Flex gap={10}>
					<Button type='primary' disabled={!canJoin} loading={busy} onClick={join}>Join as GM</Button>
					<Button type='link' onClick={() => { setMode('code'); setError(null); }}>Join with a code instead</Button>
				</Flex>
			</Space>
		);
	}

	return (
		<Space orientation='vertical' style={{ width: '100%' }} size='middle'>
			<div className='ds-text'>Enter the join code your GM gave you.</div>
			<Flex gap={10}>
				<Input
					placeholder='XXXXX-XXXXX'
					value={code}
					autoCapitalize='characters'
					autoCorrect='off'
					spellCheck={false}
					onChange={e => { setCode(e.target.value); setLookup(null); }}
					onPressEnter={() => code.trim() && findRoom()}
				/>
				<Button disabled={!code.trim() || busy} loading={busy && !lookup} onClick={findRoom}>Find room</Button>
			</Flex>
			{
				lookup ?
					<>
						<HeaderText level={2}>{lookup.room.name}</HeaderText>
						<div className='ds-text'>
							Pick <b>your own seat</b> if you've joined before on another device: your heroes come with it. Otherwise, add a new seat with your name.
						</div>
						<Radio.Group value={seatId} onChange={e => setSeatId(e.target.value as string)}>
							<Space orientation='vertical'>
								{
									lookup.seats.map(seat => (
										<Radio key={seat.id} value={seat.id}>{seat.name}{seat.isGm ? ' (GM)' : ''}</Radio>
									))
								}
								<Radio value={NEW_SEAT}>A new seat</Radio>
							</Space>
						</Radio.Group>
						{
							seatId === NEW_SEAT ?
								<Input placeholder='Your name' maxLength={60} value={newSeatName} onChange={e => setNewSeatName(e.target.value)} />
								: null
						}
						{
							selectedSeat?.isGm ?
								<Input.Password placeholder='GM key' value={gmKey} onChange={e => setGmKey(e.target.value)} />
								: null
						}
						{deviceField}
					</>
					: null
			}
			{error ? <Alert type='error' showIcon={true} title={error} /> : null}
			<Flex gap={10} wrap={true}>
				{lookup ? <Button type='primary' disabled={!canJoin} loading={busy} onClick={join}>Join</Button> : null}
				<Button type='link' onClick={() => { setMode('gm-key'); setError(null); }}>I'm the GM, adding a device</Button>
			</Flex>
		</Space>
	);
};
